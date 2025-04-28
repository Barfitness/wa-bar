/***********************************************
 * WhatsApp Bot Code (Venom + OpenAI + Whisper + Express + Multer + SUPABASE)
 * Version: Hybrid Sync (Up to 5 Recent Msgs) + Serialized ID Fix + System Msg Filter + New Models
 * Multi-Session Backend with Supabase Auth & DB Integration
 * File Serving via Secure Express Route from Local VPS Storage
 * Includes FFMPEG conversion for voice messages
 * AI Settings managed via DB/Frontend, using OpenAI API Key from ENV.
 * Handles Session Persistence, User Agent, Initialization Delay.
 * Chat Label Management Feature.
 * Uses OpenAI Function Calling/Tools for scheduling and contact updates.
 * Sends confirmation message after successful tool execution.
 * Whisper Transcription for incoming voice messages (large model, Hebrew).
 * Syncs chats labels AND attempts to fetch up to 5 recent messages from Venom to Supabase on session connect.
 * Loads full history on demand.
 * Filters out system messages during sync and incoming handling.
 ***********************************************/

// --- Core Dependencies ---
const venom = require('venom-bot');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const moment = require('moment-timezone');
const WebSocket = require('ws');
const express = require('express');
const multer = require('multer');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const { URL } = require('url');
require('dotenv').config({ path: '.env.local' });

// --- Globals & State ---
const connections = new Set();
const clientInstances = {};
let botPausedUntil = 0;
let isAiGloballyEnabled = true;
let serverSideContactNames = {}; // Simple cache for contact names on server { normPhone: name }
let activeSyncs = new Set(); // Track ongoing syncs per session

// --- Constants ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TOKENS_DIR = path.join(__dirname, 'tokens');
const HTTP_PORT = process.env.PORT || 8080;
const FILE_DELETE_DELAY = 15000; // 15 seconds
const FFMPEG_PATH = 'ffmpeg'; // Ensure ffmpeg is in PATH or provide full path
const WHISPER_MODEL = 'large'; // Using large model as requested
const WHISPER_LANGUAGE = 'he'; // Hebrew
const CONFIG = { maxUploadSize: 64 * 1024 * 1024 }; // 64MB
const VALID_LABELS = ['new', 'inprogress', 'paid', 'waiting', 'notinterested'];
const DEFAULT_LABEL = 'new';
const VALID_AI_MODELS = [
    'gpt-3.5-turbo',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1-mini-2025-04-14', // New model
    'gpt-4.1-nano-2025-04-14'  // New model
];
const RECENT_CHAT_SYNC_COUNT = 50; // How many recent chats to sync messages for initially
const HISTORY_SYNC_DELAY_MS = 200; // Delay between fetching messages for each chat in initial sync
const HISTORY_SYNC_BATCH_SIZE = 50; // How many messages to insert/upsert to DB at once
// const RECENT_MESSAGES_COUNT = 5; // REMOVED - Not using getMessages anymore

// --- Default AI Settings (Structure for Fallback) ---
const DEFAULT_AI_SETTINGS = {
    ai_instructions: 'You are a helpful WhatsApp assistant.',
    ai_model: 'gpt-4o-mini', // Default remains 4o-mini
    ai_temperature: 0.4,
    ai_max_tokens: 300,
    ai_delay_seconds: 5
};

// --- Supabase Client Initialization ---
let supabase;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables!');
    process.exit(1);
} else {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    });
    log('✅ Supabase client initialized.');
}

// --- Express App and Server Setup ---
const app = express();
const server = http.createServer(app);

app.use('/media', express.static(path.join(__dirname, 'uploads')));


// --- Static Files and Middleware ---
const PUBLIC_DIR = path.join(__dirname, 'public');
log(`ℹ️ Serving static files from: ${PUBLIC_DIR}`);
app.use(express.static(PUBLIC_DIR));
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies
app.use((req, res, next) => { // CORS Headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200); // Pre-flight request
    }
    next();
});

// Root serves index.html from PUBLIC_DIR
app.get('/', (req, res) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        log(`❌ index.html not found at ${indexPath}`);
        res.status(404).send('index.html not found');
    }
});

// --- Ensure Directories Exist ---
ensureDirExists(UPLOADS_DIR);
ensureDirExists(RECORDINGS_DIR);
ensureDirExists(TOKENS_DIR);
log('✅ Required directories checked/created.');

// --- Multer Setup (From Old Version - Verified) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = UPLOADS_DIR;
        ensureDirExists(uploadPath); // Ensure it exists before saving
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const userId = req.userId || 'unknown_user'; // Get userId from authenticated request
        const sessionId = req.body.sessionId || 'unknown_session';
        const tempId = req.body.tempId || `file_${Date.now()}`;
        let extension = path.extname(file.originalname).toLowerCase() || '.tmp';

        // Determine extension more reliably
        if (file.fieldname === 'audio') {
            const mimeMap = { 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/webm': '.webm', 'audio/wav': '.wav' };
            extension = mimeMap[file.mimetype] || '.ogg'; // Default to ogg for audio if unknown
        } else if (file.mimetype) {
            const parts = file.mimetype.split('/');
            if (parts.length > 1) {
                const map = { 'mpeg': 'mp3', 'ogg': 'ogg', 'opus': 'opus', 'webm': 'webm', 'mp4': 'mp4', 'quicktime': 'mov', 'jpeg': 'jpg', 'png': 'png', 'gif': 'gif', 'pdf': 'pdf', 'msword': 'doc', 'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
                const inferredExt = parts[1].split(';')[0].toLowerCase(); // Handle cases like 'audio/ogg; codecs=opus'
                extension = `.${map[inferredExt] || inferredExt}`;
            }
        }

        // Sanitize components for filename
        const safeTempId = String(tempId).replace(/[^a-z0-9-_]/gi, '_').substring(0, 50);
        const safeUserId = String(userId).replace(/[^a-z0-9-_]/gi, '_');
        const safeSessionId = String(sessionId).replace(/[^a-z0-9-_]/gi, '_');
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        const finalFilename = `${safeUserId}_${safeSessionId}_${safeTempId}_${uniqueSuffix}${extension}`;
        cb(null, finalFilename);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: CONFIG.maxUploadSize } });
log('✅ Multer setup complete.');

// --- Utility Functions ---
function log(msg, ...optionalParams) { const ts = moment().tz("Asia/Jerusalem").format('YYYY-MM-DD HH:mm:ss'); console.log(`[${ts}] ${msg}`, ...optionalParams); }
function isVoiceMessage(message) { const type = message?.type?.toLowerCase() || ''; const mimetype = message?.mimetype?.toLowerCase() || ''; return type === 'ptt' || type === 'audio' || mimetype.startsWith('audio/'); }
function normalizePhoneNumber(phoneNumber) { if (!phoneNumber) return ''; let n = phoneNumber.replace(/\D/g, ''); if (n.length > 9 && n.startsWith('972')) {} else if (n.length === 10 && n.startsWith('05')) { n = '972' + n.substring(1); } else if (n.length === 9 && !n.startsWith('0')) { n = '972' + n; } return n; }
function ensureDirExists(dirPath) { if (!fs.existsSync(dirPath)) { try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { log(`❌ Error creating dir ${dirPath}: ${e.message}`); } } }
function deleteFileWithDelay(filePath, delayMs) { setTimeout(() => { fs.unlink(filePath, (err) => { if (err && err.code !== 'ENOENT') log(`⚠️ Error deleting temp file ${path.basename(filePath)}: ${err.message}`); }); }, delayMs); }
function convertAudioToMp3(inputPath, outputPath) { // From Old Version
    return new Promise((resolve, reject) => {
        log(`[ffmpeg] Converting: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);
        const proc = spawn(FFMPEG_PATH, [
            '-i', inputPath,
            '-codec:a', 'libmp3lame', // Use libmp3lame for MP3 encoding
            '-qscale:a', '2',         // Good quality VBR
            outputPath
        ], { stdio: 'pipe' });

        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); }); // Capture stderr for debugging

        proc.on('close', (code) => {
            if (code === 0) {
                log(`[ffmpeg] Conversion successful: ${path.basename(outputPath)}`);
                resolve(outputPath);
            } else {
                log(`[ffmpeg] ❌ Conversion failed (code ${code}) for ${path.basename(inputPath)}`);
                log(`[ffmpeg] Stderr: ${stderr}`);
                reject(new Error(`ffmpeg failed with code ${code}: ${stderr}`));
            }
        });
        proc.on('error', (err) => {
            log(`[ffmpeg] 💥 Spawn error: ${err.message}`);
            reject(err);
        });
    });
}
function extractTranscriptFromOutput(output) { if (!output?.trim()) return ''; return output.split('\n').map(l => l.trim()).filter(l => l && !/\[\d{2}:/.test(l) && !/^[A-Z][a-z]+Warning:/.test(l)).join(' ').trim(); }
function cleanupFiles(dir, id) { setTimeout(() => { log(`🧹 [${id}] Cleaning up dir: ${dir}...`); fs.rm(dir, { recursive: true, force: true }, (e) => { if(e) log(`⚠️ Error cleaning dir ${dir}: ${e.message}`); else log(`✅ Cleaned dir: ${dir}.`); }); }, 25000); }
function cleanupOldItems(dir, age, type) { try { if (!fs.existsSync(dir)) return; const items=fs.readdirSync(dir); const now=Date.now(); items.forEach(i => { const p=path.join(dir,i); try { const s=fs.statSync(p); if (now - s.mtimeMs > age) fs.rm(p, {recursive:s.isDirectory(), force:true}, (e)=>{}); } catch (e) {} }); } catch (e) { log(`❌ Error reading dir ${dir} for cleanup: ${e.message}`); } }
function getClientBySessionId(sessionId) { return clientInstances[sessionId]; }
function getServerSideContactName(phoneNumber) { const norm = normalizePhoneNumber(phoneNumber); return serverSideContactNames[norm] || phoneNumber; }
// Helper function to introduce delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// --- NEW: Helper function to get the correct Chat ID string ---
function getChatIdString(chatIdObj) {
    if (typeof chatIdObj === 'string') {
        return chatIdObj; // Already a string
    }
    if (chatIdObj && typeof chatIdObj === 'object' && typeof chatIdObj._serialized === 'string') {
        return chatIdObj._serialized; // Extract from object
    }
    log(`⚠️ Invalid chat ID structure encountered:`, chatIdObj);
    return null; // Return null if invalid
}


// --- Supabase Helper Functions (Verified against Schema) ---
async function checkUserSessionAuthorization(userId, sessionName) { if (!userId || !sessionName) return false; try { const { count, error } = await supabase.from('user_sessions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('session_name', sessionName); if (error) { log(`❌ DB Auth Check Err (${userId}/${sessionName}): ${error.message}`); return false; } return count > 0; } catch (e) { log(`💥 Catch Auth Check Err: ${e.message}`); return false; } }
async function saveMessageToDb(userId, sessionId, chatId, msgData) { if (!userId || !sessionId || !chatId || !msgData || !msgData.role || !msgData.timestamp) { log('❌ DB Save Msg Err: Missing data'); return; } try { // First ensure the chat exists in chat_labels (important for chats without prior labels)
        const { error: labelError } = await supabase.from('chat_labels').upsert({ user_profile_id: userId, session_name: sessionId, chat_id: chatId, label: DEFAULT_LABEL }, { onConflict: 'user_profile_id, session_name, chat_id', ignoreDuplicates: true }); if (labelError && labelError.code !== '23505') { // Ignore duplicate errors
            log(`⚠️ DB Upsert Default Label Err before saving message (${chatId}): ${labelError.message}`); } // Now save the message
        const { error } = await supabase.from('messages').insert([{ user_profile_id: userId, session_name: sessionId, chat_id: chatId, venom_message_id: msgData.id, role: msgData.role, content: msgData.content, timestamp: new Date(msgData.timestamp).toISOString(), is_voice: msgData.isVoice || false, file_type: msgData.fileType, file_name: msgData.fileName, duration: msgData.duration, is_voice_transcription: msgData.isVoiceTranscription || false, failed_transcription: msgData.failed || false, reactions: msgData.reactions || null }]); if (error) { // Handle potential duplicate message error during normal operation
            if (error.code === '23505' && error.message.includes('messages_venom_message_id_key')) { log(`ℹ️ DB Save Msg Info (${chatId}): Message ${msgData.id} already exists. Skipping.`); } else { log(`❌ DB Save Msg Err (${chatId}): ${error.message}`); } } } catch (e) { log(`💥 Catch Save Msg Err: ${e.message}`); } }
async function getHistoryFromDb(userId, sessionId, chatId = null) { if (!userId || !sessionId) return {}; try { let query = supabase.from('messages').select('*').eq('user_profile_id', userId).eq('session_name', sessionId).order('timestamp', { ascending: true }); if (chatId) query = query.eq('chat_id', chatId); const { data: msgs, error } = await query; if (error) { log(`❌ DB Get History Err (${sessionId}/${chatId||'All'}): ${error.message}`); return {}; } if (!msgs) return {}; const mapMsg = m => ({ id: m.venom_message_id, role: m.role, content: m.content, timestamp: new Date(m.timestamp).getTime(), isVoice: m.is_voice, fileType: m.file_type, fileName: m.file_name, duration: m.duration, isVoiceTranscription: m.is_voice_transcription, failed: m.failed_transcription, reactions: m.reactions }); if (!chatId) { const grouped = {}; msgs.forEach(m => { if (!grouped[m.chat_id]) grouped[m.chat_id] = []; grouped[m.chat_id].push(mapMsg(m)); }); return grouped; } else { return { [chatId]: msgs.map(mapMsg) }; } } catch (e) { log(`💥 Catch Get History Err: ${e.message}`); return {}; } }
async function muteNumberInDb(userId, sessionId, phoneNum, duration) { let muteUntil = null; if (duration && duration !== 'forever') { const h = parseInt(duration); if (!isNaN(h) && h > 0) muteUntil = new Date(Date.now() + h * 36e5).toISOString(); else { log(`❌ Invalid mute duration: ${duration}`); return false; } } try { const { error } = await supabase.from('muted_numbers').upsert({ user_id: userId, session_name: sessionId, phone_number: phoneNum, mute_until: muteUntil }, { onConflict: 'user_id, session_name, phone_number' }); if (error) { log(`❌ DB Mute Err (${phoneNum}): ${error.message}`); return false; } log(`🔇 Muted ${phoneNum} until ${muteUntil||'forever'} for U:${userId} S:${sessionId}`); broadcastMuteListUpdate(userId); return true; } catch (e) { log(`💥 Catch Mute Err: ${e.message}`); return false; } }
async function unmuteNumberInDb(userId, sessionId, phoneNum) { try { const { error } = await supabase.from('muted_numbers').delete().eq('user_id', userId).eq('session_name', sessionId).eq('phone_number', phoneNum); if (error) { log(`❌ DB Unmute Err (${phoneNum}): ${error.message}`); return false; } log(`🔊 Unmuted ${phoneNum} for U:${userId} S:${sessionId}`); broadcastMuteListUpdate(userId); return true; } catch (e) { log(`💥 Catch Unmute Err: ${e.message}`); return false; } }
async function isNumberMutedInDb(userId, sessionId, phoneNum) { try { const { data, error } = await supabase.from('muted_numbers').select('mute_until').eq('user_id', userId).eq('session_name', sessionId).eq('phone_number', phoneNum).maybeSingle(); if (error) { log(`❌ DB Mute Check Err (${phoneNum}): ${error.message}`); return false; } if (!data) return false; if (data.mute_until === null) return true; const muteDate = new Date(data.mute_until); if (muteDate > new Date()) return true; else { log(`⏲️ Mute expired for ${phoneNum}. Removing.`); unmuteNumberInDb(userId, sessionId, phoneNum); return false; } } catch (e) { log(`💥 Catch Mute Check Err: ${e.message}`); return false; } }
async function broadcastMuteListUpdate(userId) { try { const { data, error } = await supabase.from('muted_numbers').select('phone_number, mute_until').eq('user_id', userId); if (error) { log(`❌ DB Mute List Fetch Err (U:${userId}): ${error.message}`); return; } const map = data.reduce((a, i)=>(a[i.phone_number]=i.mute_until?new Date(i.mute_until).getTime():null, a), {}); broadcastWebSocketMessageToUser(userId, { type: 'muteUpdated', blacklist: map }); } catch (e) { log(`💥 Catch Mute List Broadcast Err: ${e.message}`); } }
async function getUserIdForSession(sessionName) { if (!sessionName) { log(`❌ getUserIdForSession: sessionName required.`); return null; } try { const { data, error } = await supabase.from('user_sessions').select('user_id').eq('session_name', sessionName).maybeSingle(); if (error) { log(`❌ DB Err getUserIdForSession (${sessionName}): ${error.message}`); return null; } return data?.user_id || null; } catch (error) { log(`💥 Catch Err getUserIdForSession (${sessionName}): ${error.message}`); return null; } }
async function getAiUserSettings(userId) { log(`[AI Settings Get] Fetching settings for user: ${userId}`); if (!userId) { log("[AI Settings Get] WARNING: No User ID provided. Returning defaults."); return { ...DEFAULT_AI_SETTINGS }; } try { const { data, error } = await supabase.from('user_setting').select('ai_instructions, ai_model, ai_temperature, ai_max_tokens, ai_delay_seconds').eq('user_profile_id', userId).maybeSingle(); if (error && error.code !== 'PGRST116') { log(`[AI Settings Get] ❌ DB Error fetching settings for user ${userId}: ${error.message}. Using defaults.`); return { ...DEFAULT_AI_SETTINGS }; } if (!data) { log(`[AI Settings Get] INFO: No settings row found for user ${userId}. Using defaults.`); return { ...DEFAULT_AI_SETTINGS }; } log(`[AI Settings Get] ✅ Settings successfully fetched for user ${userId}.`); const settings = { ai_prompt: data.ai_instructions || DEFAULT_AI_SETTINGS.ai_instructions, ai_model: data.ai_model || DEFAULT_AI_SETTINGS.ai_model, ai_temperature: parseFloat(data.ai_temperature), ai_max_tokens: parseInt(data.ai_max_tokens), ai_delay_seconds: parseInt(data.ai_delay_seconds), }; // Validate model against the allowed list
        if (!VALID_AI_MODELS.includes(settings.ai_model)) { log(`[AI Settings Get] WARNING: Invalid model '${settings.ai_model}' found in DB for user ${userId}. Falling back to default.`); settings.ai_model = DEFAULT_AI_SETTINGS.ai_model; } if (isNaN(settings.ai_temperature) || settings.ai_temperature < 0 || settings.ai_temperature > 1) settings.ai_temperature = DEFAULT_AI_SETTINGS.ai_temperature; if (isNaN(settings.ai_max_tokens) || settings.ai_max_tokens < 50) settings.ai_max_tokens = DEFAULT_AI_SETTINGS.ai_max_tokens; if (isNaN(settings.ai_delay_seconds) || settings.ai_delay_seconds < 0) settings.ai_delay_seconds = DEFAULT_AI_SETTINGS.ai_delay_seconds; log(`[AI Settings Get] Processed settings for user ${userId}: Model=${settings.ai_model}, Temp=${settings.ai_temperature}, Tokens=${settings.ai_max_tokens}, Delay=${settings.ai_delay_seconds}`); return settings; } catch (catchError) { log(`[AI Settings Get] 💥 CATCH Error fetching settings for user ${userId}: ${catchError.message}. Using defaults.`); return { ...DEFAULT_AI_SETTINGS }; } }
async function updateAiUserSettings(userId, newSettings) { log(`[AI Settings Update v3] Received request for user: ${userId}`); if (!userId) { log("[AI Settings Update v3] ERROR: User ID missing."); return { success: false, error: "User ID missing." }; } if (!newSettings || typeof newSettings !== 'object') { log("[AI Settings Update v3] ERROR: Invalid settings object received."); return { success: false, error: "Invalid settings data." }; } const updateData = {}; if (newSettings.hasOwnProperty('ai_instructions')) { updateData.ai_instructions = (typeof newSettings.ai_instructions === 'string' && newSettings.ai_instructions.trim() !== '') ? newSettings.ai_instructions.trim() : null; log(`[AI Settings Update v3] Included ai_instructions: ${updateData.ai_instructions === null ? 'NULL' : '"' + updateData.ai_instructions.substring(0,50) + '..."'}`); } else { log(`[AI Settings Update v3] ai_instructions field was NOT received from client. Not updating it.`); } // Validate the model against the updated list
    if (newSettings.hasOwnProperty('ai_model') && typeof newSettings.ai_model === 'string' && VALID_AI_MODELS.includes(newSettings.ai_model)) { updateData.ai_model = newSettings.ai_model; } else if (newSettings.hasOwnProperty('ai_model')) { log(`[AI Settings Update v3] WARNING: Invalid model skipped: ${newSettings.ai_model}`); } if (newSettings.hasOwnProperty('ai_temperature')) { const temp = parseFloat(newSettings.ai_temperature); if (!isNaN(temp) && temp >= 0 && temp <= 1) { updateData.ai_temperature = temp; } else { log(`[AI Settings Update v3] WARNING: Invalid temperature skipped: ${newSettings.ai_temperature}`); } } if (newSettings.hasOwnProperty('ai_max_tokens')) { const tokens = parseInt(newSettings.ai_max_tokens); if (!isNaN(tokens) && tokens >= 50) { updateData.ai_max_tokens = tokens; } else { log(`[AI Settings Update v3] WARNING: Invalid max_tokens skipped: ${newSettings.ai_max_tokens}`); } } if (newSettings.hasOwnProperty('ai_delay_seconds')) { const delay = parseInt(newSettings.ai_delay_seconds); if (!isNaN(delay) && delay >= 0) { updateData.ai_delay_seconds = delay; } else { log(`[AI Settings Update v3] WARNING: Invalid delay_seconds skipped: ${newSettings.ai_delay_seconds}`); } } if (Object.keys(updateData).length === 0) { log("[AI Settings Update v3] INFO: No valid fields found to update after processing input. Skipping DB call."); return { success: true, message: "No valid fields provided for update." }; } updateData.user_profile_id = userId; log(`[AI Settings Update v3] Attempting upsert for user ${userId}. Data being sent: ${JSON.stringify(updateData)}`); try { const { data, error } = await supabase.from('user_setting').upsert(updateData, { onConflict: 'user_profile_id' }).select(); if (error) { log(`[AI Settings Update v3] ❌ Supabase upsert FAILED for user ${userId}. Error Code: ${error.code}, Message: ${error.message}, Details: ${error.details}, Hint: ${error.hint}`); console.error("[AI Settings Update v3] Full Supabase Error Object:", error); return { success: false, error: `DB Upsert Error: ${error.message}` }; } log(`[AI Settings Update v3] ✅ Supabase upsert SUCCEEDED for user ${userId}. Returned data (if any): ${JSON.stringify(data)}`); if (data && data.length > 0 && updateData.hasOwnProperty('ai_instructions') && data[0].ai_instructions !== updateData.ai_instructions) { log(`[AI Settings Update v3] ⚠️ WARNING: Upsert succeeded but returned data does not match sent ai_instructions! DB value: ${data[0].ai_instructions}`); } return { success: true }; } catch (catchError) { log(`[AI Settings Update v3] 💥 CATCH block error during upsert for user ${userId}: ${catchError.message}`); console.error("[AI Settings Update v3] Full Catch Error Object:", catchError); return { success: false, error: `Server Catch Error: ${catchError.message}` }; } }
async function getChatLabel(userId, sessionId, chatId) { try { const { data, error } = await supabase.from('chat_labels').select('label').eq('user_profile_id', userId).eq('session_name', sessionId).eq('chat_id', chatId).maybeSingle(); if (error) { log(`❌ DB Err getting label (${chatId}): ${error.message}`); return DEFAULT_LABEL; } return data?.label || DEFAULT_LABEL; } catch (error) { log(`💥 Catch Err getChatLabel (${chatId}): ${error.message}`); return DEFAULT_LABEL; } }
async function setChatLabel(userId, sessionId, chatId, label) { if (!userId || !sessionId || !chatId || !label || !VALID_LABELS.includes(label)) { log(`❌ Invalid setChatLabel params: U:${userId} S:${sessionId} C:${chatId} L:${label}`); return false; } try { const { error } = await supabase.from('chat_labels').upsert({ user_profile_id: userId, session_name: sessionId, chat_id: chatId, label: label, updated_at: new Date().toISOString() }, { onConflict: 'user_profile_id, session_name, chat_id' }); if (error) { log(`❌ DB Err setting label (${chatId} to ${label}): ${error.message}`); return false; } log(`🏷️ Set label ${chatId} -> ${label} for U:${userId} S:${sessionId}`); broadcastLabelUpdate(userId, sessionId, chatId, label); return true; } catch (error) { log(`💥 Catch Err setChatLabel (${chatId}): ${error.message}`); return false; } }
async function getAllChatLabels(userId, sessionId = null) { try { let query = supabase.from('chat_labels').select('session_name, chat_id, label').eq('user_profile_id', userId); if (sessionId) query = query.eq('session_name', sessionId); const { data, error } = await query; if (error) { log(`❌ DB Err getting all labels (U:${userId} S:${sessionId||'All'}): ${error.message}`); return {}; } const labelsMap = {}; data.forEach(item => { if (!labelsMap[item.session_name]) labelsMap[item.session_name] = {}; labelsMap[item.session_name][item.chat_id] = item.label; }); return labelsMap; } catch (error) { log(`💥 Catch Err getAllChatLabels (U:${userId}): ${error.message}`); return {}; } }
async function updateContactDetailsInDb(userId, phoneNumber, details) { const normPhone = normalizePhoneNumber(phoneNumber); if (!userId || !normPhone || !details || typeof details !== 'object') { log(`❌ Invalid updateContactDetailsInDb params: U:${userId} P:${normPhone} Details:`, details); return false; } const updatePayload = { user_id: userId, phone_number: normPhone }; let hasUpdates = false; if (details.contact_name !== undefined && typeof details.contact_name === 'string') { updatePayload.contact_name = details.contact_name.trim() || null; // Allow clearing name
        hasUpdates = true; } if (details.business_field !== undefined && typeof details.business_field === 'string') { updatePayload.business_field = details.business_field.trim() || null; // Allow clearing field
        hasUpdates = true; } if (details.notes !== undefined && typeof details.notes === 'string') { updatePayload.notes = details.notes.trim() || null; // Allow clearing notes
        hasUpdates = true; } if (!hasUpdates) { log(`ℹ️ No valid fields to update in contacts table for ${normPhone}`); return true; } log(`📝 Updating contact details for ${normPhone}:`, updatePayload); try { const { error } = await supabase.from('contacts').upsert(updatePayload, { onConflict: 'user_id, phone_number' }); if (error) { log(`❌ DB Contact Upsert Err (${normPhone}): ${error.message}`); return false; } log(`✅ Contact details updated for ${normPhone}`); if (updatePayload.contact_name !== undefined) { serverSideContactNames[normPhone] = updatePayload.contact_name; // Update server cache
        } // Send back only the fields that were actually intended for update
        const updatedFields = {}; if (details.contact_name !== undefined) updatedFields.contact_name = updatePayload.contact_name; if (details.business_field !== undefined) updatedFields.business_field = updatePayload.business_field; if (details.notes !== undefined) updatedFields.notes = updatePayload.notes;
        broadcastWebSocketMessageToUser(userId, { type: 'contactUpdated', phoneNumber: normPhone, details: updatedFields }); return true; } catch (e) { log(`💥 Catch Contact Upsert Err (${normPhone}): ${e.message}`); return false; } }
async function scheduleCallInDb(userId, sessionId, chatId, details) { const phoneNum = normalizePhoneNumber(chatId.replace(/@c\.us$/, '')); if (!userId || !sessionId || !chatId || !details || !details.requested_time_text) { log(`❌ Invalid scheduleCallInDb params:`, { userId, sessionId, chatId, details }); return false; } const insertPayload = { user_profile_id: userId, session_name: sessionId, chat_id: chatId, callback_phone_number: phoneNum, customer_name: details.customer_name || getServerSideContactName(phoneNum) || null, requested_time_text: details.requested_time_text, status: 'pending' }; log(`📞 Scheduling call for ${chatId}:`, insertPayload); try { const { data, error } = await supabase.from('scheduled_calls').insert(insertPayload).select(); if (error) { log(`❌ DB Schedule Call Insert Err (${chatId}): ${error.message}`); return false; } log(`✅ Call scheduled successfully for ${chatId}`); broadcastWebSocketMessageToUser(userId, { type: 'callScheduled', sessionId, chatId, details: data[0] }); return true; } catch (e) { log(`💥 Catch Schedule Call Insert Err (${chatId}): ${e.message}`); return false; } }
async function updateScheduledCallInDb(userId, sessionId, chatId, details) { if (!userId || !sessionId || !chatId || !details || !details.new_requested_time_text) { log(`❌ Invalid updateScheduledCallInDb params:`, { userId, sessionId, chatId, details }); return false; } const updatePayload = { requested_time_text: details.new_requested_time_text, status: 'pending', updated_at: new Date().toISOString() }; log(`🔄 Updating scheduled call for ${chatId}:`, updatePayload); try { const { data, error } = await supabase.from('scheduled_calls').update(updatePayload).eq('user_profile_id', userId).eq('session_name', sessionId).eq('chat_id', chatId).eq('status', 'pending').select(); if (error) { log(`❌ DB Update Scheduled Call Err (${chatId}): ${error.message}`); return false; } if (data && data.length > 0) { log(`✅ Scheduled call updated successfully for ${chatId}`); broadcastWebSocketMessageToUser(userId, { type: 'callUpdated', sessionId, chatId, details: data[0] }); return true; } else { log(`⚠️ No pending scheduled call found to update for ${chatId}`); return false; } } catch (e) { log(`💥 Catch Update Scheduled Call Err (${chatId}): ${e.message}`); return false; } }
async function getScheduledCallInfo(userId, sessionId, chatId) { if (!userId || !sessionId || !chatId) { log(`❌ Invalid getScheduledCallInfo params`); return null; } try { log(`ℹ️ Fetching scheduled call info for chat ${chatId}`); const { data, error } = await supabase.from('scheduled_calls').select('requested_time_text, status').eq('user_profile_id', userId).eq('session_name', sessionId).eq('chat_id', chatId).order('created_at', { ascending: false }).limit(1).maybeSingle(); if (error) { log(`❌ DB Error fetching scheduled call for ${chatId}: ${error.message}`); return null; } log(`✅ Scheduled call info fetched for ${chatId}:`, data); return data; } catch (e) { log(`💥 Catch Error fetching scheduled call for ${chatId}: ${e.message}`); return null; } }

// --- Authentication Middleware (HTTP) ---
const authenticateToken = async (req, res, next) => { const authHeader = req.headers['authorization']; const token = authHeader?.split(' ')[1]; if (!token) return res.sendStatus(401); try { const { data: { user }, error } = await supabase.auth.getUser(token); if (error) { return res.sendStatus(403); } if (!user) { return res.sendStatus(403); } req.userId = user.id; next(); } catch (e) { log(`💥 Catch HTTP Auth Error: ${e.message}`); return res.sendStatus(500); } };

// --- WebSocket Server Setup ---
const wss = new WebSocket.Server({ noServer: true }); log('✅ WebSocket server setup.');

// --- WebSocket Connection Handler ---
wss.on('connection', (ws, request) => { log(`🌐 WS Client connected (User: ${ws.userId})`); connections.add(ws); sendInitialDataToUser(ws); ws.on('message', async (message) => { const userId = ws.userId; if (!userId) { log('⚠️ WS Msg unauth conn.'); ws.close(4001, "Auth missing"); return; } try { const data = JSON.parse(message.toString()); const { sessionId, chatId, phoneNumber, message: messageData, duration, name, venomMessageId, reaction, enabled, tempId, settings, label, contactDetails, note } = data;
        let isAuthorized = true;
        // Added 'requestFullHistory' to sessionCommands
        const sessionCommands = ['requestHistory', 'requestAllChatsHistory', 'mute', 'unmute', 'sendMessage', 'addContact', 'deleteMessage', 'reactMessage', 'changeLabel', 'updateContact', 'addNote', 'getScheduledCall', 'requestFullHistory'];
        if (sessionId && sessionCommands.includes(data.type || data.command)) { isAuthorized = await checkUserSessionAuthorization(userId, sessionId); if (!isAuthorized) { log(`🚫 WS User ${userId} unauth for session ${sessionId}`); ws.send(JSON.stringify({ type: 'error', message: `Unauthorized for session ${sessionId}` })); return; } } const client = sessionId ? getClientBySessionId(sessionId) : null;

        switch (data.type || data.command) {
            case 'requestInitialData': sendInitialDataToUser(ws); break;
            case 'requestHistory': if (!client || !chatId) { log(`❌ WS ReqHist Err`); break; } const h = await getHistoryFromDb(userId, sessionId, chatId); ws.send(JSON.stringify({ type: 'historyData', sessionId, chatId, messages: h[chatId] || [] })); break;
            case 'requestAllChatsHistory': if (!client) { log(`❌ WS ReqAllHist Err`); break; } const ah = await getHistoryFromDb(userId, sessionId); const labels = await getAllChatLabels(userId, sessionId); ws.send(JSON.stringify({ type: 'allChatsHistoryData', sessionId, chats: ah, labels: labels[sessionId] || {} })); break;
            case 'mute': case 'command:mute': if (!client || !phoneNumber || duration === undefined) { log(`❌ WS Mute Err`); break; } await muteNumberInDb(userId, sessionId, normalizePhoneNumber(phoneNumber), duration); break;
            case 'unmute': case 'command:unmute': if (!client || !phoneNumber) { log(`❌ WS Unmute Err`); break; } await unmuteNumberInDb(userId, sessionId, normalizePhoneNumber(phoneNumber)); break;
            case 'sendMessage': if (!client || !chatId || !messageData?.content) { log(`❌ WS SendMsg Err`); break; } try { const r = await client.sendText(chatId, messageData.content); await saveMessageToDb(userId, sessionId, chatId, { id: r.id, role: 'assistant', content: messageData.content, timestamp: Date.now() }); broadcastWebSocketMessageToUser(userId, { type: 'messageSent', tempId: tempId, finalId: r.id, finalTimestamp: Date.now() }); } catch (e) { log(`❌ SendText Err: ${e.message}`); ws.send(JSON.stringify({ type: 'messageSendError', error: e.message, tempId: tempId })); } break;
            case 'addContact': if (!phoneNumber || name === undefined) { log(`❌ WS AddContact Err`); break; } await updateContactDetailsInDb(userId, phoneNumber, { contact_name: name }); break; // Let DB function broadcast
            case 'updateContact': if (!phoneNumber || !contactDetails) { log(`❌ WS UpdateContact Err`); break; } await updateContactDetailsInDb(userId, phoneNumber, contactDetails); break; // Let DB function broadcast
            case 'addNote': if (!phoneNumber || typeof note !== 'string') { log(`❌ WS AddNote Err`); break; } await updateContactDetailsInDb(userId, phoneNumber, { notes: note }); break; // Let DB function broadcast
            case 'deleteMessage': if (!client || !chatId || !venomMessageId) { log(`❌ WS DelMsg Err`); break; } try { await client.deleteMessage(chatId, venomMessageId, false); try { await supabase.from('messages').delete().match({ user_profile_id: userId, session_name: sessionId, chat_id: chatId, venom_message_id: venomMessageId }); } catch(dbErr){ log(`⚠️ DB DelMsg Err: ${dbErr.message}`); } ws.send(JSON.stringify({ type: 'messageDeleted', success: true, chatId, messageId: venomMessageId })); } catch (e) { log(`❌ DelMsg API Err: ${e.message}`); ws.send(JSON.stringify({ type: 'messageDeleteError', error: e.message, chatId, messageId: venomMessageId })); } break;
            case 'reactMessage': if (!client || !chatId || !venomMessageId || reaction === undefined) { log(`❌ WS ReactMsg Err`); break; } try { await client.sendReactionToMessage(venomMessageId, reaction || ''); ws.send(JSON.stringify({ type: 'reactionSent', success: true, chatId, messageId: venomMessageId, reaction })); } catch (e) { log(`❌ ReactMsg API Err: ${e.message}`); if(e.message.includes("not a function")){ log("⚠️ sendReactionToMessage might not be supported by this Venom version or session state."); ws.send(JSON.stringify({ type: 'reactionSendError', error: 'Reaction failed (unsupported?)', chatId, messageId: venomMessageId })); } else { ws.send(JSON.stringify({ type: 'reactionSendError', error: e.message, chatId, messageId: venomMessageId })); } } break;
            case 'setAiState': if (typeof enabled !== 'boolean') break; isAiGloballyEnabled = enabled; log(`🤖 AI Global State -> ${enabled} by User ${userId}`); ws.send(JSON.stringify({ type: 'aiStateConfirmed', enabled })); break;
            case 'getAiSettings': const currentSettings = await getAiUserSettings(userId); ws.send(JSON.stringify({ type: 'aiSettingsData', settings: currentSettings })); break;
            case 'updateAiSettings': if (!settings) { log(`❌ WS UpdateSettings Err`); break; } const updateResult = await updateAiUserSettings(userId, settings); ws.send(JSON.stringify({ type: 'aiSettingsUpdated', success: updateResult.success, error: updateResult.error })); break;
            case 'changeLabel': if (!sessionId || !chatId || !label || !VALID_LABELS.includes(label)) { log(`❌ WS ChangeLabel Err`); break; } await setChatLabel(userId, sessionId, chatId, label); break;
            case 'getScheduledCall':
                if (!sessionId || !chatId) { log(`❌ WS getScheduledCall Err: Missing sessionId or chatId`); break; }
                log(`ℹ️ WS Received getScheduledCall for ${chatId}`);
                const callInfo = await getScheduledCallInfo(userId, sessionId, chatId);
                ws.send(JSON.stringify({ type: 'scheduledCallData', sessionId, chatId, callInfo: callInfo }));
                break;
            // --- NEW: Handle Request for Full History ---
            case 'requestFullHistory':
                if (!client || !chatId) {
                    log(`❌ WS requestFullHistory Err: Missing client or chatId`);
                    ws.send(JSON.stringify({ type: 'fullHistoryError', sessionId, chatId, error: 'Invalid request parameters.' }));
                    break;
                }
                const chatIdStr = getChatIdString(chatId); // Ensure we have a string ID
                if (!chatIdStr) {
                     log(`❌ WS requestFullHistory Err: Invalid chatId structure.`);
                     ws.send(JSON.stringify({ type: 'fullHistoryError', sessionId, chatId: chatIdStr, error: 'Invalid chat ID.' }));
                     break;
                }
                log(`[Full History - ${sessionId}] ⏳ Received request for full history of ${chatIdStr}`);
                ws.send(JSON.stringify({ type: 'fullHistoryLoading', sessionId, chatId: chatIdStr })); // Inform client we're loading
                try {
                    const allMessages = await client.loadAndGetAllMessagesInChat(chatIdStr);
                    log(`[Full History - ${sessionId}] ✅ Loaded ${allMessages?.length || 0} messages for ${chatIdStr} from Venom.`);

                    if (allMessages && allMessages.length > 0) {
                        // Map messages to DB format
                        const messagesToUpsert = allMessages.map(m => ({
                            user_profile_id: userId,
                            session_name: sessionId,
                            chat_id: chatIdStr, // Use the validated string ID
                            venom_message_id: m.id,
                            role: m.fromMe ? 'assistant' : 'user', // Adjust role based on fromMe
                            content: m.body || m.caption || (isVoiceMessage(m) ? '[Voice]' : '[Media]') || '',
                            timestamp: new Date(m.timestamp * 1000).toISOString(),
                            is_voice: isVoiceMessage(m),
                            file_type: m.type !== 'chat' && m.type !== 'ptt' ? m.type : null,
                            file_name: m.filename,
                            duration: m.duration,
                            // Assume transcription status is unknown for older messages
                            is_voice_transcription: false,
                            failed_transcription: false,
                            reactions: m.reactions || null
                        }));

                        // Upsert messages in batches
                        log(`[Full History - ${sessionId}] 💾 Upserting ${messagesToUpsert.length} messages to DB for ${chatIdStr}...`);
                        for (let i = 0; i < messagesToUpsert.length; i += HISTORY_SYNC_BATCH_SIZE) {
                            const batch = messagesToUpsert.slice(i, i + HISTORY_SYNC_BATCH_SIZE);
                            const { error: upsertError } = await supabase
                                .from('messages')
                                .upsert(batch, { onConflict: 'venom_message_id' }); // Upsert based on venom_message_id to avoid duplicates

                            if (upsertError) {
                                log(`[Full History - ${sessionId}] ❌ DB Upsert Error (Batch ${i / HISTORY_SYNC_BATCH_SIZE}) for ${chatIdStr}: ${upsertError.message}`);
                                // Decide if we should stop or continue? Continue for now.
                            }
                        }
                        log(`[Full History - ${sessionId}] ✅ DB Upsert complete for ${chatIdStr}.`);

                        // Send the full, mapped history back to the client
                        const mappedHistory = messagesToUpsert.map(m => ({
                            id: m.venom_message_id,
                            role: m.role,
                            content: m.content,
                            timestamp: new Date(m.timestamp).getTime(), // Convert back to timestamp ms for client
                            isVoice: m.is_voice,
                            fileType: m.file_type,
                            fileName: m.file_name,
                            duration: m.duration,
                            isVoiceTranscription: m.is_voice_transcription,
                            failed: m.failed_transcription,
                            reactions: m.reactions
                        })).sort((a, b) => a.timestamp - b.timestamp); // Ensure sorted

                        ws.send(JSON.stringify({ type: 'fullHistoryData', sessionId, chatId: chatIdStr, messages: mappedHistory }));

                    } else {
                        log(`[Full History - ${sessionId}] ℹ️ No messages returned by loadAndGetAllMessagesInChat for ${chatIdStr}. Sending empty history.`);
                        ws.send(JSON.stringify({ type: 'fullHistoryData', sessionId, chatId: chatIdStr, messages: [] }));
                    }

                } catch (err) {
                    log(`[Full History - ${sessionId}] 💥 Error loading full history for ${chatIdStr}: ${err.message}`);
                    ws.send(JSON.stringify({ type: 'fullHistoryError', sessionId, chatId: chatIdStr, error: `Failed to load full history: ${err.message}` }));
                }
                break;
            // --- END NEW ---
            default: log(`❓ [WS User: ${userId}] Unknown cmd: ${data.type || data.command}`);
        } } catch (err) { log(`❌ WS Msg Proc. Err (User ${userId}): ${err.message} | Raw: ${message.toString().substring(0, 200)}`); try { ws.send(JSON.stringify({ type: 'error', message: 'Msg proc. error' })); } catch(e){} } });
    ws.on('close', () => { log(`🔌 WS Client disconnected (User: ${ws.userId})`); connections.delete(ws); }); ws.on('error', (e) => { log(`💥 WS Error (User: ${ws.userId}): ${e.message}`); connections.delete(ws); });
});

// --- WebSocket Broadcast Functions ---
function broadcastWebSocketMessageToUser(userId, message) { if (!userId || connections.size === 0) return; const msgStr = JSON.stringify(message); connections.forEach(c => { if (c.userId === userId && c.readyState === WebSocket.OPEN) c.send(msgStr, e => { if(e) log(`⚠️ WS Send Error (U:${userId}): ${e.message}`); }); }); }
function broadcastWebSocketMessage(message, excludeWs = null) { if (connections.size === 0) return; const msgStr = JSON.stringify(message); connections.forEach(c => { if (c !== excludeWs && c.readyState === WebSocket.OPEN) c.send(msgStr, e => { if(e) log(`⚠️ WS Global Send Error: ${e.message}`); }); }); }
function broadcastLabelUpdate(userId, sessionId, chatId, label) { broadcastWebSocketMessageToUser(userId, { type: 'labelUpdated', sessionId, chatId, label }); }

// --- Send Initial Data to User ---
async function sendInitialDataToUser(ws) { const userId = ws.userId; if (!userId) return; try { const [sessionsRes, mutesRes, contactsRes, aiSettings, labelsRes] = await Promise.all([ supabase.from('user_sessions').select('session_name, user_id, status').eq('user_id', userId), supabase.from('muted_numbers').select('phone_number, mute_until').eq('user_id', userId), supabase.from('contacts').select('phone_number, contact_name, business_field, notes').eq('user_id', userId), getAiUserSettings(userId), getAllChatLabels(userId) ]); if (sessionsRes.error) throw new Error(`Session fetch failed: ${sessionsRes.error.message}`); if (mutesRes.error) throw new Error(`Mutes fetch failed: ${mutesRes.error.message}`); if (contactsRes.error) throw new Error(`Contacts fetch failed: ${contactsRes.error.message}`); const userSessions = (sessionsRes.data || []).map(s => ({ id: s.session_name, name: s.session_name, status: clientInstances[s.session_name]?.status || s.status || 'unknown' })); const userMutes = (mutesRes.data || []).reduce((a, i)=>(a[i.phone_number]=i.mute_until?new Date(i.mute_until).getTime():null, a), {}); serverSideContactNames = {}; const userContacts = (contactsRes.data || []).reduce((acc, c) => { acc[c.phone_number] = { name: c.contact_name, field: c.business_field, notes: c.notes }; if (c.contact_name) { serverSideContactNames[c.phone_number] = c.contact_name; } return acc; }, {}); const userLabels = labelsRes || {}; const settingsForFrontend = { ...aiSettings }; if (settingsForFrontend.ai_prompt && !settingsForFrontend.ai_instructions) { settingsForFrontend.ai_instructions = settingsForFrontend.ai_prompt; } delete settingsForFrontend.ai_prompt; ws.send(JSON.stringify({ type: 'init', sessions: userSessions, blacklist: userMutes, contacts: userContacts, settings: settingsForFrontend, labels: userLabels })); for (const session of userSessions) { if (session.user_id === userId || await checkUserSessionAuthorization(userId, session.id)) { // Send only labels initially, history will be loaded by sync or on demand
            // Send recent history from DB for the initially synced chats
            const recentHistory = await getHistoryFromDb(userId, session.id); // Get all history for the session from DB
            ws.send(JSON.stringify({ type: 'allChatsHistoryData', sessionId: session.id, chats: recentHistory || {}, labels: userLabels[session.id] || {} })); } else { log(`⚠️ Sec Warn: User ${userId} no own ${session.id}. Skip history.`); } } } catch (e) { log(`❌ Error sending initial data (U:${userId}): ${e.message}`); try{ ws.close(4002, "Init data fail"); } catch(closeErr){} } }

/// --- Express Routes (Including Uploads from Old Version) ---

// --- REMOVED Secured media route ---
/*
async function checkFileAccess(req, res, next) { const { sessionId, chatId, fileName } = req.params; const userId = req.userId; if (!sessionId || !chatId || !fileName) return res.status(400).send('Missing params'); try { const isSessAuth = await checkUserSessionAuthorization(userId, sessionId); if (!isSessAuth) { return res.sendStatus(403); } const { count, error } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('user_profile_id', userId).eq('session_name', sessionId).eq('chat_id', chatId).eq('file_name', fileName); if (error) { log(`❌ DB File Access Check Err: ${error.message}`); return res.sendStatus(500); } if (count === 0) { log(`🚫 File Access Denied: ${fileName} user ${userId}`); return res.sendStatus(404); } next(); } catch (e) { log(`💥 Catch File Access Check Err: ${e.message}`); return res.sendStatus(500); } }
app.get('/media/:sessionId/:chatId/:fileName', authenticateToken, checkFileAccess, (req, res) => { const { sessionId, chatId, fileName } = req.params; // Added sessionId and chatId
    const safeFileName = path.basename(fileName); if (safeFileName !== fileName || safeFileName.includes('..')) { log(`🚫 Invalid filename: ${fileName}`); return res.status(400).send('Invalid filename.'); } const filePath = path.join(UPLOADS_DIR, safeFileName); if (fs.existsSync(filePath)) { res.sendFile(filePath, (err) => { if (err && !res.headersSent) { log(`❌ SendFile Err ${filePath}: ${err.message}`); res.status(err.status || 500).end(); } }); } else { log(`❓ File not found: ${filePath} (Session: ${sessionId}, Chat: ${chatId})`); res.sendStatus(404); } });
*/
// --- Use simple static serving for /media (ensure app.use('/media', ...) is defined earlier) ---
// Note: The line `app.use('/media', express.static(path.join(__dirname, 'uploads')));` should already exist near the top after `const server = http.createServer(app);`

// General File Upload Route (Images, Videos, Docs) - Remains Authenticated
app.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
    const userId = req.userId;
    if (!req.file) return res.status(400).json({ success: false, message: 'No file.' });
    const { sessionId, chatId, fileType, tempId } = req.body;
    const filePath = req.file.path;
    const finalFileName = req.file.filename;
    const isAuthorized = await checkUserSessionAuthorization(userId, sessionId);
    if (!isAuthorized) {
        log(`🚫 [/upload] Unauth User ${userId} S:${sessionId}`);
        fs.unlinkSync(filePath);
        return res.status(403).json({ success: false, message: 'Unauth.' });
    }
    const client = getClientBySessionId(sessionId);
    if (!client) {
        log(`❌ [Upload] Invalid session ${sessionId}`);
        fs.unlinkSync(filePath);
        return res.status(400).json({ success: false, message: 'Invalid session.' });
    }
    res.status(200).json({ success: true, message: 'Sending...', tempId }); // Respond quickly
    try {
        let sendPromise;
        const caption = req.body.caption || "";
        if (fileType === 'image') sendPromise = client.sendImage(chatId, filePath, finalFileName, caption);
        else if (fileType === 'video') sendPromise = client.sendFile(chatId, filePath, finalFileName, caption);
        else sendPromise = client.sendFile(chatId, filePath, finalFileName, caption); // Default to sendFile
        const result = await sendPromise;
        await saveMessageToDb(userId, sessionId, chatId, { id: result.id, role: 'assistant', fileType, fileName: finalFileName, timestamp: Date.now(), content: caption });
        broadcastWebSocketMessageToUser(userId, { type: 'fileSent', success: true, sessionId, chatId, tempId, messageId: result.id, fileName: finalFileName, fileType, timestamp: Date.now() });
        deleteFileWithDelay(filePath, FILE_DELETE_DELAY);
    } catch (e) {
        log(`❌ [/upload] Send Err: ${e.message}`);
        broadcastWebSocketMessageToUser(userId, { type: 'fileSendError', success: false, sessionId, chatId, tempId, fileName: finalFileName, fileType, error: e.message });
        deleteFileWithDelay(filePath, FILE_DELETE_DELAY);
    }
});

// Audio Upload Route (Handles conversion and sending as PTT) - Remains Authenticated
app.post('/upload-audio', authenticateToken, upload.single('audio'), async (req, res) => {
    const userId = req.userId;
    if (!req.file) return res.status(400).json({ success: false, message: 'No audio.' });
    const { sessionId, chatId, duration, tempId } = req.body;
    const originalFilePath = req.file.path;
    const finalFileName = req.file.filename; // Original uploaded filename
    const mp3FileName = path.basename(originalFilePath).replace(/(\.[^.]+)$/i, '.mp3'); // Create MP3 filename based on unique uploaded name
    const mp3FilePath = path.join(UPLOADS_DIR, mp3FileName); // Full path for the MP3 file
    const isAuthorized = await checkUserSessionAuthorization(userId, sessionId);
    if (!isAuthorized) {
        log(`🚫 [/upload-audio] Unauth User ${userId} S:${sessionId}`);
        fs.unlinkSync(originalFilePath);
        return res.status(403).json({ success: false, message: 'Unauth.' });
    }
    const client = getClientBySessionId(sessionId);
    if (!client) {
        log(`❌ [UploadAudio] Invalid session ${sessionId}`);
        fs.unlinkSync(originalFilePath);
        return res.status(400).json({ success: false, message: 'Invalid session.' });
    }
    res.status(200).json({ success: true, message: 'Converting...', tempId }); // Respond quickly
    try {
        await convertAudioToMp3(originalFilePath, mp3FilePath);
        const result = await client.sendVoice(chatId, mp3FilePath); // Send the converted MP3 as PTT
        await saveMessageToDb(userId, sessionId, chatId, {
            id: result.id,
            role: 'assistant',
            isVoice: true,
            duration,
            timestamp: Date.now(),
            content: '[Voice Message]',
            fileName: mp3FileName, // Save MP3 filename
            fileType: 'audio'
        });
        broadcastWebSocketMessageToUser(userId, { type: 'voiceSent', success: true, sessionId, chatId, tempId, messageId: result.id, duration, timestamp: Date.now() });
        // Delete both original and converted files after delay
        deleteFileWithDelay(originalFilePath, FILE_DELETE_DELAY);
        deleteFileWithDelay(mp3FilePath, FILE_DELETE_DELAY);
    } catch (e) {
        log(`❌ [/upload-audio] Err: ${e.message}`);
        broadcastWebSocketMessageToUser(userId, { type: 'voiceSendError', success: false, sessionId, chatId, tempId, duration, error: e.message });
        deleteFileWithDelay(originalFilePath, FILE_DELETE_DELAY);
        if (fs.existsSync(mp3FilePath)) deleteFileWithDelay(mp3FilePath, FILE_DELETE_DELAY);
    }
});

// --- Transcription Function (Updated Model/Lang) ---
async function transcribeAudio(audioFile, outputDir, uniqueId) {
    return new Promise(async (resolve, reject) => {
        const command = 'whisper';
        const args = [
            path.basename(audioFile),
            '--language', WHISPER_LANGUAGE,
            '--model', WHISPER_MODEL,
            '--output_format', 'txt',
            '--output_dir', '.', // Output to the current working directory (outputDir)
            '--verbose', 'False' // Keep it less noisy unless debugging
        ];
        const transcriptFileName = `${path.basename(audioFile, path.extname(audioFile))}.txt`;
        const expectedTranscriptFile = path.join(outputDir, transcriptFileName);
        const processLogFile = path.join(outputDir, `whisper_process_${uniqueId}.log`);

        log(`[${uniqueId}] 🚀 Running Whisper (Model: ${WHISPER_MODEL}, Lang: ${WHISPER_LANGUAGE})...`);
        const logStream = fs.createWriteStream(processLogFile, { flags: 'a' });
        logStream.write(`--- Whisper Start (${new Date().toISOString()}) ---\nCmd: ${command} ${args.join(' ')}\nCWD: ${outputDir}\nAudio: ${audioFile}\n\n`);

        try {
            const whisperProcess = spawn(command, args, {
                cwd: outputDir, // Set working directory for Whisper
                stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin, pipe stdout/stderr
                shell: process.platform === 'win32' // Use shell on Windows if needed
            });

            let stdout = '';
            let stderr = '';
            whisperProcess.stdout.on('data', (data) => { stdout += data.toString(); logStream.write(`[STDOUT] ${data}`); });
            whisperProcess.stderr.on('data', (data) => { stderr += data.toString(); logStream.write(`[STDERR] ${data}`); });

            whisperProcess.on('error', (error) => {
                log(`[${uniqueId}] ❌ Whisper Start Err: ${error.message}`);
                logStream.write(`\n--- PROC START ERR ---\n${error.message}\n`);
                logStream.end();
                reject(error);
            });

            whisperProcess.on('close', (code) => {
                log(`[${uniqueId}] ✅ Whisper exit code ${code}`);
                logStream.write(`\n--- Whisper End (${new Date().toISOString()}) Code: ${code} ---\n`);
                logStream.end();

                if (stderr.trim() && code !== 0) {
                    log(`[${uniqueId}] Whisper stderr: ${stderr.trim()}`);
                }

                if (fs.existsSync(expectedTranscriptFile)) {
                    try {
                        const content = fs.readFileSync(expectedTranscriptFile, 'utf8');
                        resolve(extractTranscriptFromOutput(content));
                    } catch (readErr) {
                        log(`[${uniqueId}] ⚠️ Err reading transcript file ${expectedTranscriptFile}: ${readErr.message}`);
                        resolve(''); // Resolve with empty string on read error
                    }
                } else {
                    log(`[${uniqueId}] ❓ Transcript file not found: ${expectedTranscriptFile}. Exit code: ${code}. Stderr: ${stderr.trim()}`);
                    resolve(''); // Resolve with empty string if file not found
                }
            });

        } catch (spawnError) {
            log(`[${uniqueId}] 💥 Err spawning Whisper: ${spawnError.message}`);
            logStream.write(`\n--- SPAWN ERR ---\n${spawnError.message}\n`);
            logStream.end();
            reject(spawnError);
        }
    });
}

// --- OpenAI Function with Tools (Updated Prompt Guidance) ---
async function askOpenAI(messagesHistory, userSettings) {
    // ... (API key check, history check remain the same) ...
    if (!OPENAI_API_KEY) { log("❌ OpenAI Key missing."); return { response: "שגיאה: מפתח OpenAI חסר.", tool_calls: null }; }
    if (!messagesHistory || messagesHistory.length === 0) { return { response: "מצטערת, אין לי הקשר לשיחה.", tool_calls: null }; }

    const { ai_prompt, ai_model: model, ai_temperature: temperature, ai_max_tokens: maxTokens } = userSettings;
    log(`[askOpenAI] Using settings: Model=${model}, Temp=${temperature}, MaxTokens=${maxTokens}`);
    const nowIsrael = moment().tz("Asia/Jerusalem").format('HH:mm');
    const systemPromptContent = (ai_prompt || DEFAULT_AI_SETTINGS.ai_instructions).replace('{current_time_israel}', nowIsrael);
    log(`[askOpenAI] Injected time ${nowIsrael}. Final system prompt starts with: "${systemPromptContent.substring(0, 100)}..."`);

    const historyLimit = 20; // Keep this limit for the AI context window
    const recentMessages = messagesHistory.slice(-historyLimit);
    const messagesPayload = [
        { role: 'system', content: systemPromptContent },
        ...recentMessages.map(({ role, content }) => ({ role: role, content: content || "" }))
    ];
    const validPayload = messagesPayload.filter(msg => ['system', 'user', 'assistant', 'tool'].includes(msg.role) && typeof msg.content === 'string'); // Allow 'tool' role for responses

    if (validPayload.length <= 1) { return { response: "אני צריכה קצת יותר מידע כדי לענות.", tool_calls: null }; }

    // Define tools as before
    const tools = [ { type: "function", function: { name: "update_contact_details", description: "עדכון פרטי איש קשר כמו שם או תחום עיסוק.", parameters: { type: "object", properties: { contact_name: { type: "string", description: "שם הלקוח המלא." }, business_field: { type: "string", description: "תחום העיסוק של העסק." } } }, }, }, { type: "function", function: { name: "schedule_call", description: "קביעת שיחת טלפון חדשה עם הלקוח *לאחר* שהמשתמש אישר זמן ספציפי.", parameters: { type: "object", properties: { requested_time_text: { type: "string", description: "תיאור טקסטואלי של הזמן שהמשתמש אישר (למשל 'מחר ב-10:00', 'יום חמישי ב-16:00'). חובה לקבל אישור מהמשתמש על הזמן לפני קריאה לפונקציה זו." }, customer_name: { type: "string", description: "שם הלקוח (אם ידוע)." } }, required: ["requested_time_text"], }, }, }, { type: "function", function: { name: "update_scheduled_call", description: "עדכון זמן של שיחה טלפונית שכבר נקבעה, *לאחר* שהמשתמש אישר זמן חדש.", parameters: { type: "object", properties: { new_requested_time_text: { type: "string", description: "תיאור טקסטואלי של הזמן החדש שהמשתמש אישר." } }, required: ["new_requested_time_text"], }, }, } ];

    log(`[askOpenAI] Asking OpenAI ${model} with ${validPayload.length} messages and ${tools.length} tools.`);
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: model, // Use the model specified in user settings
            messages: validPayload,
            tools: tools,
            tool_choice: "auto", // Let OpenAI decide when to use tools
            temperature: temperature,
            max_tokens: maxTokens
        }, {
            headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 45000 // Increased timeout slightly
        });

        const message = response.data.choices[0]?.message;
        if (!message) { log("[askOpenAI] ❌ OpenAI returned no message in choice."); console.error("[askOpenAI] OpenAI Raw Response:", JSON.stringify(response.data, null, 2)); return { response: "משהו השתבש בתשובה שלי.", tool_calls: null }; }

        const botResponseText = message.content?.trim() || null;
        const toolCalls = message.tool_calls || null;

        log(`[askOpenAI] Received response. Text: "${botResponseText ? botResponseText.substring(0,100)+'...' : 'None'}", Tool Calls: ${toolCalls ? toolCalls.length : 'None'}`);
        if (toolCalls) { log(`[askOpenAI] Identified tool calls:`, toolCalls.map(tc => tc.function.name)); }

        return { response: botResponseText, tool_calls: toolCalls };

    } catch (error) {
        // ... (Error handling remains the same) ...
        let errorMessage = "קושי טכני כרגע."; if (error.response) { log(`[askOpenAI] ❌ OpenAI API Error: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`); errorMessage = `שגיאת AI: ${error.response.data?.error?.message || error.response.statusText}`; } else if (error.request) { log(`[askOpenAI] ❌ OpenAI Request Error (Network/Timeout): ${error.message}`); errorMessage = "בעיית תקשורת עם שירות ה-AI."; if (error.code === 'ECONNABORTED') { errorMessage = "שירות ה-AI לא ענה בזמן."; } } else { log(`[askOpenAI] 💥 Unexpected Error in askOpenAI: ${error.message}`); } return { response: errorMessage, tool_calls: null };
    }
}

// --- Main Bot Logic Handler (Integrates Transcription & Updated AI Processing) ---
async function handleIncomingMessage(client, sessionName, message) {
    // --- ADD FILTER AT THE BEGINNING ---
    const allowedTypes = ['chat', 'ptt', 'image', 'video', 'document', 'audio', 'location', 'vcard'];
    // message.type might be undefined for some system messages initially, filter them too
    if (!message || typeof message !== 'object' || !message.from || !message.type || !allowedTypes.includes(message.type.toLowerCase())) {
        // Ignore messages with types like notification_template, e2e_notification, etc.
        // Also ignore if message object or type is somehow missing or invalid
        log(`[handleIncomingMessage] ℹ️ Ignoring non-standard/missing/invalid message type: ${message?.type} from ${message?.from?._serialized || message?.from}`);
        return; // Exit the function if the type is not allowed or missing
    }
    // --- END FILTER ---

    // --- Initial Checks (Ignore irrelevant messages, muted numbers, owner messages, AI pause) ---
    const chatId = getChatIdString(message.from); // Use helper to ensure string ID
    if (!chatId || message.isGroupMsg || chatId === 'status@broadcast') {
        // Filter out groups, status broadcast, or invalid IDs after type check
        return;
    }

    const clientNumber = chatId.replace(/@c\.us$/, '');
    const messageId = message.id;
    const userId = await getUserIdForSession(sessionName);
    if (!userId) { log(`[handleIncomingMessage] ⚠️ No userId found for session ${sessionName}. Ignoring message.`); return; }
    if (await isNumberMutedInDb(userId, sessionName, clientNumber)) { log(`[handleIncomingMessage] 🔇 Message from muted number ${clientNumber}. Ignoring.`); return; }
    if (message.fromMe) {
        botPausedUntil = Date.now() + 300000; // Pause AI for 5 minutes on owner message
        log(`[handleIncomingMessage] 🛑 Owner message in ${chatId}. Pausing AI for 5m.`);
        const ownerMsg = {
            id: messageId,
            role: 'assistant',
            content: message.body || message.caption || (isVoiceMessage(message) ? '[Voice]' : '[Media]'),
            timestamp: message.timestamp * 1000 || Date.now(),
            isVoice: isVoiceMessage(message),
            fileType: message.type !== 'chat' && message.type !== 'ptt' ? message.type : null,
            fileName: message.filename
        };
        await saveMessageToDb(userId, sessionName, chatId, ownerMsg);
        broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: ownerMsg });
        return;
    }
    if (Date.now() < botPausedUntil) { log(`[handleIncomingMessage] ⏳ AI is paused until ${new Date(botPausedUntil).toLocaleTimeString()}. Ignoring message from ${clientNumber}.`); const ignoredMsg = { id: messageId, role: 'user', content: '[Ignored - Bot paused]', timestamp: message.timestamp * 1000 || Date.now(), isVoice: isVoiceMessage(message)}; await saveMessageToDb(userId, sessionName, chatId, ignoredMsg); broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: ignoredMsg }); return; }

    // --- Now proceed with processing the allowed message type ---
    const userSettings = await getAiUserSettings(userId);
    const baseMsg = { id: messageId, role: 'user', timestamp: message.timestamp * 1000 || Date.now(), reactions: message.reactions || {} };

    // Handle AI Disabled State
    if (!isAiGloballyEnabled) { log(`[handleIncomingMessage] 🤖 AI globally disabled. Storing message from ${clientNumber}.`); const ignoredMsg = { ...baseMsg, content: isVoiceMessage(message) ? '[Voice - AI Off]' : (message.body?.trim() || message.caption?.trim() || '[Media - AI Off]'), fileType: message.type !== 'chat' && message.type !== 'ptt' ? message.type : (isVoiceMessage(message) ? 'audio' : null), fileName: message.filename, isVoice: isVoiceMessage(message), duration: message.duration, aiDisabled: true }; await saveMessageToDb(userId, sessionName, chatId, ignoredMsg); broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: ignoredMsg }); return; }

    let userContentForAI = '';
    let messageToSave = { ...baseMsg };

    // Handle Different Message Types (Voice, Media, Text)
    if (isVoiceMessage(message)) {
        log(`[handleIncomingMessage] 🎤 Voice message received from ${clientNumber}. Processing...`);
        const uniqueId = `${userId.substring(0, 4)}_${sessionName}_${clientNumber}_${Date.now()}`;
        const procDir = path.join(RECORDINGS_DIR, uniqueId);
        let audioPath = '';
        let mediaFileName = `audio_${uniqueId}.ogg`; // Default name

        messageToSave = { ...baseMsg, content: '[Voice Message]', isVoice: true, duration: message.duration, fileName: null };
        await saveMessageToDb(userId, sessionName, chatId, messageToSave);
        broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: messageToSave });

        try {
            ensureDirExists(procDir);
            const buffer = await client.decryptFile(message);
            const mimeExtMap = {'audio/ogg; codecs=opus': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/webm': '.webm'};
            const extension = mimeExtMap[message.mimetype] || '.ogg';
            mediaFileName = `audio_${uniqueId}${extension}`;
            audioPath = path.join(procDir, mediaFileName);
            fs.writeFileSync(audioPath, buffer);
            await supabase.from('messages').update({ file_name: mediaFileName }).match({ venom_message_id: messageId, user_profile_id: userId, session_name: sessionName });

            transcribeAudio(audioPath, procDir, uniqueId)
                .then(async (transcript) => {
                    let transcriptContent = '';
                    let transcriptionFailed = true;

                    if (transcript && transcript.trim()) {
                        transcriptContent = transcript.trim();
                        userContentForAI = transcriptContent; // Use transcript for AI
                        transcriptionFailed = false;
                        log(`[handleIncomingMessage] ✅ Transcription successful for ${uniqueId}: "${transcriptContent.substring(0, 50)}..."`);
                        broadcastWebSocketMessageToUser(userId, { type: 'transcription', sessionId: sessionName, chatId, transcript: transcriptContent, originalMessageId: messageId });
                    } else {
                        log(`[handleIncomingMessage] ❌ Transcription failed or empty for ${uniqueId}.`);
                        transcriptContent = '[Voice - Transcr. Failed]';
                        broadcastWebSocketMessageToUser(userId, { type: 'transcriptionFailed', sessionId: sessionName, chatId, originalMessageId: messageId, error: 'Empty or failed transcript' });
                        userContentForAI = transcriptContent; // Skip AI if transcription failed
                    }

                    // Update the message content in DB with transcription result
                    try {
                        await supabase.from('messages').update({
                            content: transcriptContent,
                            is_voice_transcription: true,
                            failed_transcription: transcriptionFailed
                        }).match({ venom_message_id: messageId, user_profile_id: userId, session_name: sessionName });
                    } catch (dbError) {
                        log(`[handleIncomingMessage] ❌ DB Update Transcription Error: ${dbError.message}`);
                    }

                    // If transcription succeeded, proceed with AI processing
                    if (!transcriptionFailed) {
                        await processWithAI(client, userId, sessionName, chatId, clientNumber, userContentForAI, userSettings);
                    } else {
                        log(`[handleIncomingMessage] Skipping AI call due to transcription failure for ${uniqueId}.`);
                    }
                })
                .catch(async (transcriptionError) => {
                    log(`[handleIncomingMessage] 💥 Transcription Promise Error for ${uniqueId}: ${transcriptionError.message}`);
                    broadcastWebSocketMessageToUser(userId, { type: 'transcriptionFailed', sessionId: sessionName, chatId, originalMessageId: messageId, error: transcriptionError.message });
                    try {
                        await supabase.from('messages').update({
                            content: '[Voice - Transcr. Error]',
                            is_voice_transcription: true,
                            failed_transcription: true
                        }).match({ venom_message_id: messageId, user_profile_id: userId, session_name: sessionName });
                    } catch (dbError) {
                         log(`[handleIncomingMessage] ❌ DB Update Transcription Error (Catch): ${dbError.message}`);
                    }
                })
                .finally(() => {
                    cleanupFiles(procDir, uniqueId); // Clean up the temp folder after processing
                });

        } catch (error) {
            log(`[handleIncomingMessage] 💥 Voice Decrypt/Save Error for ${uniqueId}: ${error.message}`);
            broadcastWebSocketMessageToUser(userId, { type: 'transcriptionFailed', sessionId: sessionName, chatId, originalMessageId: messageId, error: `File processing error: ${error.message}` });
            try {
                await supabase.from('messages').update({
                    content: '[Voice - Proc. Error]',
                    is_voice_transcription: true, // Mark as transcription related even on processing error
                    failed_transcription: true
                }).match({ venom_message_id: messageId, user_profile_id: userId, session_name: sessionName });
            } catch (dbError) {
                 log(`[handleIncomingMessage] ❌ DB Update Proc. Error (Catch): ${dbError.message}`);
            }
            cleanupFiles(procDir, uniqueId); // Ensure cleanup even on early error
        }
        return; // End processing for voice message here

    } else if (message.type !== 'chat' && message.type !== 'ptt') { // Already filtered allowed types, this covers media
        // --- Handle Media Messages (Non-Voice) ---
        log(`[handleIncomingMessage] 🖼️ Media (${message.type}) received from ${clientNumber}. Storing attempt...`);
        let mediaFileName = null; // Start with null
        let localFilePath = null;
        let saveSuccess = false;

        try {
            const buffer = await client.decryptFile(message);
            const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
            const safeUserId = String(userId).replace(/[^a-z0-9-_]/gi, '_');
            const safeSessionId = String(sessionName).replace(/[^a-z0-9-_]/gi, '_');
            const safeChatId = String(chatId).replace(/[^a-z0-9-_@.]/gi, '_');
            let extension = path.extname(message.filename || '').toLowerCase() || '';
            // Try to infer extension from mimetype if filename is missing/unreliable
            if (!extension && message.mimetype) {
                const mimeExtMap = {'image/jpeg':'jpg', 'image/png':'png', 'image/gif':'gif', 'video/mp4':'mp4', 'application/pdf':'pdf'};
                 // Add more mappings as needed
                 const mimeTypePart = message.mimetype.split('/')[1]?.split('+')[0];
                 if (mimeTypePart) {
                    extension = `.${mimeExtMap[message.mimetype] || mimeTypePart || 'bin'}`;
                 } else {
                    extension = '.bin'; // Fallback extension
                 }
            }
             if (!extension) extension = '.bin'; // Ensure there's always an extension

            // Use a more reliable base name if message.filename is missing
            const baseName = message.filename ? path.basename(message.filename, path.extname(message.filename)) : message.type;
            mediaFileName = `${safeUserId}_${safeSessionId}_${safeChatId}_${baseName}_${uniqueSuffix}${extension}`;
            localFilePath = path.join(UPLOADS_DIR, mediaFileName);

            fs.writeFileSync(localFilePath, buffer);
            log(`[handleIncomingMessage] ✅ Successfully saved media file: ${mediaFileName}`);
            saveSuccess = true; // Mark success

        } catch (mediaError) {
            log(`[handleIncomingMessage] ⚠️ Error decrypting/saving media (ID: ${message.id}): ${mediaError.message}`);
            // Don't set mediaFileName, keep it null to indicate failure
        }

        // Prepare message data for DB and WS
        messageToSave = {
            ...baseMsg,
            content: saveSuccess ? (message.caption || `[${message.type.toUpperCase()}]`) : `[שגיאה בשמירת קובץ ${message.type}]`, // Clearer error message
            fileType: saveSuccess ? message.type : 'error', // Mark as error type if save failed
            fileName: saveSuccess ? mediaFileName : null, // Only save filename if successful
            duration: message.duration
        };

        await saveMessageToDb(userId, sessionName, chatId, messageToSave);
        broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: messageToSave });
        return;

    } else { // Must be 'chat' type based on initial filter
        // --- Handle Text Messages ---
        userContentForAI = message.body?.trim();
        if (!userContentForAI) {
            log(`[handleIncomingMessage] ⚠️ Empty text message received from ${clientNumber}. Ignoring.`);
            return; // Ignore empty text messages
        }

        log(`[handleIncomingMessage] 💬 Text from ${clientNumber}: "${userContentForAI}"`);
        messageToSave = { ...baseMsg, content: userContentForAI };
        await saveMessageToDb(userId, sessionName, chatId, messageToSave);
        broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: messageToSave });

        // Process text message with AI
        await processWithAI(client, userId, sessionName, chatId, clientNumber, userContentForAI, userSettings);
    }
}

// --- Refactored AI Processing Logic with Confirmation ---
async function processWithAI(client, userId, sessionName, chatId, clientNumber, userContent, userSettings) {
    log(`[processWithAI] Processing content for ${chatId}: "${userContent.substring(0, 50)}..."`);
    const currentHistory = (await getHistoryFromDb(userId, sessionName, chatId))[chatId] || [];

    // Add the current user message to the history for the AI call
    const historyForAI = [...currentHistory];
    // Find the latest user message (might be the one just saved or the transcript)
    const latestUserMsg = historyForAI.slice().reverse().find(m => m.role === 'user');
    if (latestUserMsg && latestUserMsg.content !== userContent) {
         // If the latest user message in history isn't the current content (e.g., placeholder voice), add it
         historyForAI.push({ role: 'user', content: userContent, timestamp: Date.now() }); // Add a temporary representation
    }

    const aiResult = await askOpenAI(historyForAI, userSettings);
    const aiResponseText = aiResult.response;
    const toolCalls = aiResult.tool_calls;
    let toolExecutedSuccessfully = false; // Flag to track if a tool was called AND confirmed

    if (toolCalls && toolCalls.length > 0) {
        log(`[processWithAI] AI requested ${toolCalls.length} tool call(s) for ${chatId}.`);
        for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            let functionArgs = {};
            try {
                functionArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (parseError) {
                log(`[processWithAI] ⚠️ Error parsing arguments for tool ${functionName}: ${parseError.message}`);
                continue; // Skip this tool call
            }

            log(`[processWithAI] Executing tool: ${functionName} with args:`, functionArgs);
            let toolSuccess = false;
            let confirmationText = null; // Text to send back to user after tool success

            // --- Tool Execution Logic ---
            if (functionName === 'update_contact_details') {
                toolSuccess = await updateContactDetailsInDb(userId, clientNumber, functionArgs);
                if(toolSuccess) {
                    // Use specific confirmation from prompt if available, otherwise generic
                    confirmationText = `תודה ${functionArgs.contact_name || ''}, עדכנתי את הפרטים 🙂`;
                    // Optional: Update label if needed based on contact update (e.g., if field is relevant)
                    // await setChatLabel(userId, sessionName, chatId, 'inprogress');
                } else {
                     confirmationText = "אני מצטערת, הייתה בעיה בעדכון הפרטים כרגע.";
                }
            } else if (functionName === 'schedule_call') {
                // Ensure requested_time_text exists
                if (!functionArgs.requested_time_text) {
                     log(`[processWithAI] ⚠️ Tool 'schedule_call' called without 'requested_time_text'. Skipping.`);
                     confirmationText = "אני צריכה לדעת מתי תרצה שנקבע את השיחה."; // Ask again
                } else {
                    toolSuccess = await scheduleCallInDb(userId, sessionName, chatId, functionArgs);
                    if (toolSuccess) {
                        await setChatLabel(userId, sessionName, chatId, 'waiting'); // Set label to waiting
                        // Use the EXACT confirmation message from the prompt
                        confirmationText = `מעולה! השיחה עם מיה נקבעה ל־${functionArgs.requested_time_text}. היא תתקשר אליך בשעה הזו 📞 מצוין, נקבעה שיחת טלפון.`;
                    } else {
                        confirmationText = "אני מצטערת, הייתה בעיה בקביעת השיחה כרגע. מיה תבדוק את זה ידנית.";
                    }
                }
            } else if (functionName === 'update_scheduled_call') {
                 // Ensure new_requested_time_text exists
                 if (!functionArgs.new_requested_time_text) {
                      log(`[processWithAI] ⚠️ Tool 'update_scheduled_call' called without 'new_requested_time_text'. Skipping.`);
                      confirmationText = "לאיזה זמן חדש תרצה שנעדכן את השיחה?"; // Ask again
                 } else {
                    toolSuccess = await updateScheduledCallInDb(userId, sessionName, chatId, functionArgs);
                    if(toolSuccess) {
                        // Use the EXACT confirmation message from the prompt
                        confirmationText = `בסדר גמור – עדכנתי את מועד השיחה ל־${functionArgs.new_requested_time_text}. תודה!`;
                    } else {
                        confirmationText = "אני מצטערת, הייתה בעיה בעדכון מועד השיחה. אולי השיחה כבר לא הייתה בהמתנה?";
                    }
                 }
            } else {
                log(`[processWithAI] ❓ Unknown tool function requested: ${functionName}`);
                confirmationText = `ניסיתי לבצע פעולה לא מוכרת (${functionName}).`; // Inform user about unknown tool
            }
            // --- End Tool Execution Logic ---

            log(`[processWithAI] Tool ${functionName} execution ${toolSuccess ? 'succeeded' : 'failed'}.`);

            // Send confirmation message ONLY if a specific text was generated
            if (confirmationText) {
                log(`[processWithAI] 💬 Sending tool confirmation/response to ${chatId}: "${confirmationText}"`);
                const confirmMsg = { role: 'assistant', content: confirmationText, timestamp: Date.now() };
                try {
                    const sentConfirmMsg = await client.sendText(chatId, confirmationText);
                    confirmMsg.id = sentConfirmMsg.id;
                    await saveMessageToDb(userId, sessionName, chatId, confirmMsg);
                    broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: confirmMsg });
                    toolExecutedSuccessfully = true; // Mark that a tool confirmation was sent
                } catch (sendError) {
                    log(`[processWithAI] ❌ Error sending tool confirmation message: ${sendError.message}`);
                    // Don't set toolExecutedSuccessfully to true if sending failed
                }
            }
        } // End loop through tool calls
    }

    // --- Send Original AI Text Response (if applicable) ---
    // Send the original text response ONLY if:
    // 1. A text response exists.
    // 2. No tool confirmation message was successfully sent in this turn.
    if (aiResponseText && !toolExecutedSuccessfully) {
        const delayMs = (userSettings.ai_delay_seconds ?? DEFAULT_AI_SETTINGS.ai_delay_seconds) * 1000;
        if (delayMs > 0) {
            log(`[processWithAI] ⏳ Applying AI delay of ${delayMs / 1000}s before sending original text response...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
        log(`[processWithAI] 🤖 Sending original AI text response to ${chatId}: "${aiResponseText.substring(0, 100)}..."`);
        const botMsg = { role: 'assistant', content: aiResponseText, timestamp: Date.now() };
        try {
            const sentMsg = await client.sendText(chatId, aiResponseText);
            botMsg.id = sentMsg.id;
            await saveMessageToDb(userId, sessionName, chatId, botMsg);
            broadcastWebSocketMessageToUser(userId, { type: 'newMessage', sessionId: sessionName, chatId, phoneNumber: clientNumber, message: botMsg });
        } catch (sendError) {
            log(`[processWithAI] ❌ Send Bot Text Resp Error: ${sendError.message}`);
        }
    } else if (!aiResponseText && !toolCalls) {
        log(`[processWithAI] ⚠️ No text response and no tool calls from AI for ${chatId}. Sending nothing.`);
    } else if (aiResponseText && toolExecutedSuccessfully) {
         log(`[processWithAI] ℹ️ Suppressing original AI text response for ${chatId} because a tool confirmation was sent.`);
    }
}

// --- UPDATED: Sync Chats and Recent Messages from Venom ---
async function syncChatsFromVenom(client, userId, sessionName) {
    if (!client || !userId || !sessionName) {
        log(`[Chat Sync - ${sessionName}] ❌ Invalid parameters for syncing.`);
        return;
    }
    if (activeSyncs.has(sessionName)) {
        log(`[Chat Sync - ${sessionName}] ⚠️ Sync already in progress for this session. Skipping.`);
        return;
    }
    activeSyncs.add(sessionName);
    log(`[Chat Sync - ${sessionName}] 🔄 Starting chat sync for user ${userId}...`);
    let chatsSyncedCount = 0;
    let messagesSyncedCount = 0;
    try {
        // 1. Get all chats from Venom
        const venomChats = await client.getAllChats();
        if (!Array.isArray(venomChats)) {
            log(`[Chat Sync - ${sessionName}] ⚠️ client.getAllChats() did not return an array.`);
            activeSyncs.delete(sessionName);
            return;
        }
        log(`[Chat Sync - ${sessionName}] 📲 Found ${venomChats.length} chats in Venom.`);

        // Filter out groups and status broadcasts, ensuring valid IDs
        const validVenomChats = venomChats.filter(chat => {
            const chatId = getChatIdString(chat.id); // Use helper to get string ID
            return chatId && !chat.isGroup && chatId !== 'status@broadcast';
        });
        log(`[Chat Sync - ${sessionName}] 👤 Found ${validVenomChats.length} valid individual chats.`);

        if (validVenomChats.length === 0) {
            log(`[Chat Sync - ${sessionName}] ✅ No individual chats to sync.`);
            activeSyncs.delete(sessionName);
            return;
        }

        // 2. Ensure default label exists for all chats
        const labelsToUpsert = validVenomChats.map(chat => ({
            user_profile_id: userId,
            session_name: sessionName,
            chat_id: getChatIdString(chat.id), // Use helper again
            label: DEFAULT_LABEL,
        })).filter(label => label.chat_id); // Filter out any potential null IDs from helper

        if (labelsToUpsert.length > 0) {
             log(`[Chat Sync - ${sessionName}] 🏷️ Ensuring labels exist for ${labelsToUpsert.length} chats...`);
             const { error: labelUpsertError } = await supabase
                 .from('chat_labels')
                 .upsert(labelsToUpsert, { onConflict: 'user_profile_id, session_name, chat_id', ignoreDuplicates: true });

             if (labelUpsertError) {
                 log(`[Chat Sync - ${sessionName}] ❌ Error upserting labels: ${labelUpsertError.message}`);
             } else {
                 log(`[Chat Sync - ${sessionName}] ✅ Labels ensured.`);
                 chatsSyncedCount = labelsToUpsert.length;
             }
        } else {
            log(`[Chat Sync - ${sessionName}] ⚠️ No valid chats found after filtering/normalizing IDs for label upsert.`);
        }

        // 3. Sort chats by last activity (most recent first)
        const sortedVenomChats = validVenomChats.sort((a, b) => (b.t || 0) - (a.t || 0));

        // 4. Get recent messages for the top X chats (using getAllMessagesInChat)
        const recentChatsToSync = sortedVenomChats.slice(0, RECENT_CHAT_SYNC_COUNT);
        log(`[Chat Sync - ${sessionName}] ✉️ Fetching recent messages (from memory) for the top ${recentChatsToSync.length} chats...`);

        const allRecentMessagesToUpsert = [];
        let chatCounter = 0;
        for (const chat of recentChatsToSync) {
            chatCounter++;
            const currentChatId = getChatIdString(chat.id); // Use helper function

            if (!currentChatId) {
                 log(`[Chat Sync - ${sessionName}]   (${chatCounter}/${recentChatsToSync.length}) ❌ Skipping chat due to invalid/missing ID. Original chat.id:`, chat.id);
                 await delay(HISTORY_SYNC_DELAY_MS);
                 continue;
            }

            log(`[Chat Sync - ${sessionName}]   (${chatCounter}/${recentChatsToSync.length}) Preparing to fetch messages from memory for ID: ${currentChatId}`);

            try {
                // --- Use getAllMessagesInChat (memory cache) ---
                const messages = await client.getAllMessagesInChat(currentChatId);
                // --- ---
                log(`[Chat Sync - ${sessionName}]   (${chatCounter}/${recentChatsToSync.length}) Found ${messages?.length || 0} messages in memory for ${currentChatId}.`);

                if (messages && messages.length > 0) {
                    // --- FILTER SYSTEM MESSAGES ---
                    const allowedTypes = ['chat', 'ptt', 'image', 'video', 'document', 'audio', 'location', 'vcard'];
                    const filteredMessages = messages.filter(m =>
                        m.type && allowedTypes.includes(m.type.toLowerCase()) && m.id
                    );
                    // --- END FILTER ---

                    if (filteredMessages.length > 0) {
                        const messagesToAdd = filteredMessages.map(m => ({
                            user_profile_id: userId,
                            session_name: sessionName,
                            chat_id: currentChatId,
                            venom_message_id: m.id,
                            role: m.fromMe ? 'assistant' : 'user',
                            content: m.body || m.caption || (isVoiceMessage(m) ? '[Voice]' : '[Media]') || '',
                            timestamp: new Date(m.timestamp * 1000).toISOString(),
                            is_voice: isVoiceMessage(m),
                            file_type: m.type !== 'chat' && m.type !== 'ptt' ? m.type : null,
                            file_name: m.filename,
                            duration: m.duration,
                            is_voice_transcription: false,
                            failed_transcription: false,
                            reactions: m.reactions || null
                        }));
                        allRecentMessagesToUpsert.push(...messagesToAdd);
                    }
                }
                await delay(HISTORY_SYNC_DELAY_MS);

            } catch (msgError) {
                log(`[Chat Sync - ${sessionName}] ⚠️ Error fetching messages for chat ${currentChatId}: ${msgError.message}`);
                 if (msgError.message?.includes('Protocol error') || msgError.message?.includes('Target closed')) {
                    log(`[Chat Sync - ${sessionName}] ⛔ Critical error fetching messages, stopping sync.`);
                    activeSyncs.delete(sessionName);
                    return;
                }
            }
        }


        // 5. Upsert all collected recent messages to DB in batches
        if (allRecentMessagesToUpsert.length > 0) {
            log(`[Chat Sync - ${sessionName}] 💾 Upserting ${allRecentMessagesToUpsert.length} recent messages to DB...`);
            for (let i = 0; i < allRecentMessagesToUpsert.length; i += HISTORY_SYNC_BATCH_SIZE) {
                const batch = allRecentMessagesToUpsert.slice(i, i + HISTORY_SYNC_BATCH_SIZE);
                const { error: upsertError } = await supabase
                    .from('messages')
                    .upsert(batch, { onConflict: 'venom_message_id' });

                if (upsertError) {
                    log(`[Chat Sync - ${sessionName}] ❌ DB Upsert Error (Batch ${i / HISTORY_SYNC_BATCH_SIZE}): ${upsertError.message}`);
                } else {
                    messagesSyncedCount += batch.length;
                }
            }
            log(`[Chat Sync - ${sessionName}] ✅ DB Upsert complete. Synced ${messagesSyncedCount} recent messages.`);
        } else {
            log(`[Chat Sync - ${sessionName}] ℹ️ No recent messages found/valid for the top ${recentChatsToSync.length} chats.`);
        }

        // 6. Notify the client that initial sync is done
        broadcastWebSocketMessageToUser(userId, { type: 'initialSyncComplete', sessionId: sessionName, chatsProcessed: chatsSyncedCount, messagesProcessed: messagesSyncedCount });
        const userWs = Array.from(connections).find(ws => ws.userId === userId);
        if (userWs) {
             sendInitialDataToUser(userWs);
        } else {
            log(`[Chat Sync - ${sessionName}] ⚠️ Could not find WebSocket connection for user ${userId} to send updated initial data.`);
        }


    } catch (error) {
        log(`[Chat Sync - ${sessionName}] 💥 Unexpected error during chat sync: ${error.message}`);
        if (error.message?.includes('Store not found') || error.message?.includes('Protocol error')) {
             log(`[Chat Sync - ${sessionName}]   Hint: WAPI store might not be ready or connection issue. Retrying might help or session needs restart.`);
        }
    } finally {
        activeSyncs.delete(sessionName);
        log(`[Chat Sync - ${sessionName}] 🏁 Sync process finished.`);
    }
}


// --- Bot Initialization & Session Management ---
async function startVenomSession(client, sessionName) {
    log(`[${sessionName}] ✅ Session setup...`);
    client.session = sessionName;
    client.status = 'CONNECTED'; // Initial assumption, will be updated by state changes
    clientInstances[sessionName] = client;
    const ownerUserId = await getUserIdForSession(sessionName);

    if (ownerUserId) {
        broadcastWebSocketMessageToUser(ownerUserId, { type: 'sessionStatusUpdate', sessionId: sessionName, status: client.status });
    } else {
        log(`⚠️ [${sessionName}] Owner not found after create.`);
        broadcastWebSocketMessage({ type: 'sessionStatusUpdate', sessionId: sessionName, status: client.status });
    }

    // --- Event Listeners ---
    client.onMessage(async (m) => {
        try {
            await handleIncomingMessage(client, sessionName, m);
        } catch (e) {
            log(`💥 UNCAUGHT handleMsg Err (S:${sessionName}): ${e.message}\n${e.stack}`);
        }
    });

    client.onStateChange(async (s) => {
        log(`[${sessionName}] State: ${s}`);
        const currentOwnerId = await getUserIdForSession(sessionName);
        if (client) client.status = s;
        try {
            await supabase.from('user_sessions').update({ status: s, last_activity_at: new Date().toISOString() }).eq('session_name', sessionName);
        } catch(e){
            log(`💥 DB Session Status Update Err: ${e.message}`);
        }
        if(currentOwnerId) broadcastWebSocketMessageToUser(currentOwnerId, { type: 'sessionStatusUpdate', sessionId: sessionName, status: s });
        else broadcastWebSocketMessage({ type: 'sessionStatusUpdate', sessionId: sessionName, status: s });

        if (['CONFLICT', 'UNLAUNCHED', 'UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTED'].includes(s)) {
            log(`[${sessionName}] Critical state (${s}). Closing.`);
            if (clientInstances[sessionName]) {
                // Use a try-catch for close as it might also throw errors
                try {
                    await clientInstances[sessionName].close();
                 } catch (closeError) {
                     log(`[${sessionName}] ⚠️ Error during client.close(): ${closeError.message}`);
                 }
                delete clientInstances[sessionName];
            }
            if(currentOwnerId) broadcastWebSocketMessageToUser(currentOwnerId, { type: 'sessionStatusUpdate', sessionId: sessionName, status: 'CLOSED' });
            else broadcastWebSocketMessage({ type: 'sessionStatusUpdate', sessionId: sessionName, status: 'CLOSED' });
        }
    });

    client.onStreamChange(async (s) => {
        log(`[${sessionName}] Stream: ${s}`);
        const currentOwnerId = await getUserIdForSession(sessionName);
        if (client) client.streamStatus = s;
        const streamStatus = `STREAM_${s}`;
        if(currentOwnerId) broadcastWebSocketMessageToUser(currentOwnerId, { type: 'sessionStatusUpdate', sessionId: sessionName, status: streamStatus });
        else broadcastWebSocketMessage({ type: 'sessionStatusUpdate', sessionId: sessionName, status: streamStatus });
    });

    log(`[${sessionName}] ✅ Session setup complete. Starting initial chat & recent message sync...`);

    // --- Sync Chats & Recent Messages After Setup ---
    if (ownerUserId) {
        // Delay slightly to ensure WAPI is fully ready after connection
        setTimeout(async () => {
            await syncChatsFromVenom(client, ownerUserId, sessionName);
        }, 5000); // 5-second delay, adjust if needed
    } else {
        log(`[${sessionName}] ⚠️ Cannot sync chats, owner user ID not found.`);
    }
}

async function initializeExistingSessions() {
    log('🔄 Init existing sessions...');
    try {
        log('   Querying Supabase...');
        const { data: sessions, error } = await supabase.from('user_sessions').select('session_name, user_id, status');
        if (error) throw error;
        if (!sessions || sessions.length === 0) {
            log('   ℹ️ No sessions found.');
            return;
        }

        const { data: initialContacts, error: contactError } = await supabase.from('contacts').select('phone_number, contact_name');
        if (contactError) {
            log(`⚠️ Error fetching initial contacts: ${contactError.message}`);
        } else {
            initialContacts.forEach(c => { if(c.contact_name) serverSideContactNames[c.phone_number] = c.contact_name; });
            log(`ℹ️ Loaded ${Object.keys(serverSideContactNames).length} contact names into server cache.`);
        }

        log(`   Found ${sessions.length} sessions. Starting loop...`);
        let delayMs = 0; // Renamed for clarity
        let i = 0;
        for (const session of sessions) {
            i++;
            const sessionName = session.session_name;
            const ownerUserId = session.user_id;

            if (clientInstances[sessionName]) {
                log(`   ⚠️ [${i}/${sessions.length}] ${sessionName} exists. Skip.`);
                continue;
            }

            log(`   ⏳ [${i}/${sessions.length}] Wait ${delayMs/1000}s -> ${sessionName}...`);
            await delay(delayMs); // Use helper function
            delayMs = 15000; // Increase delay between session starts

            log(`   🚀 [${i}/${sessions.length}] Create ${sessionName} (User: ${ownerUserId})...`);
            try {
                const client = await venom.create(
                    sessionName,
                    (base64Qr, asciiQR, attempt) => {
                        log(`   [${sessionName}] QR attempt ${attempt}. Logged. Send Base64.`);
                        if (asciiQR) console.log(asciiQR);
                        if (ownerUserId) broadcastWebSocketMessageToUser(ownerUserId, { type: 'qrCode', sessionId: sessionName, qr: base64Qr });
                    },
                    (statusSession, session) => {
                        log(`   [${session}] Status CB: ${statusSession}`);
                        const c = getClientBySessionId(session);
                        if (c) c.status = statusSession;
                        // Update status immediately via WS if possible
                        const currentOwnerId = ownerUserId || getUserIdForSession(session); // Try refetching if needed
                        if(currentOwnerId) broadcastWebSocketMessageToUser(currentOwnerId, { type: 'sessionStatusUpdate', sessionId: session, status: statusSession });
                        else broadcastWebSocketMessage({ type: 'sessionStatusUpdate', sessionId: session, status: statusSession });

                         // Update DB status as well
                         supabase.from('user_sessions').update({ status: statusSession }).eq('session_name', session).then(({ error }) => {
                             if (error) log(`💥 DB Status CB Update Err (${session}): ${error.message}`);
                         });
                    },
                    {
                        multidevice: true,
                        deleteSession: false,
                        folderNameToken: TOKENS_DIR,
                        headless: 'new', // Use 'new' headless mode
                        browserArgs: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage', '--log-level=3', '--disable-logging'], // Added logging flags
                        autoClose: 0, // Keep session open
                        waitForLogin: true, // Wait for QR scan or logged in state
                        logQR: true, // Log QR to console
                        // Use a more common User Agent
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
                    }
                );
                log(`   ✅ [${sessionName}] Create resolved. Setup listeners...`);
                await startVenomSession(client, sessionName); // This now includes the chat sync call
                log(`   🏁 [${sessionName}] Init complete.`);
            } catch (err) {
                log(`   ❌ [${sessionName}] Init Err: ${err.message}`);
                if (err.message?.includes('ERR_PUPPETEER')) log('      Hint: Chromium issue?');
                if (err.message?.includes('Timeout')) log('      Hint: WA Web load/QR scan timeout?');
                if(ownerUserId) broadcastWebSocketMessageToUser(ownerUserId, { type: 'sessionStatusUpdate', sessionId: sessionName, status: 'ERROR_CREATE' });
                 // Also update DB status on creation error
                 try {
                     await supabase.from('user_sessions').update({ status: 'ERROR_CREATE' }).eq('session_name', sessionName);
                 } catch(dbErr){ log(`💥 DB Session Error Status Update Err: ${dbErr.message}`); }
            }
        }
        log('   🏁 Finished session init loop.');
    } catch (error) {
        log(`❌ Error in initializeExistingSessions: ${error.message}`);
    }
}

// --- Process Exit Handlers ---
async function gracefulShutdown() { log('🛑 SIGINT/SIGTERM received. Shutdown...'); wss.close(); connections.forEach(ws => ws.terminate()); await Promise.all(Object.values(clientInstances).map(c => { log(`   Closing ${c.session}...`); return c.close().catch(e => log(`   ⚠️ Err closing ${c.session}: ${e.message}`)); })); server.close(() => { log('✅ HTTP server closed.'); process.exit(0); }); setTimeout(() => { log('⚠️ Timeout. Forcing exit.'); process.exit(1); }, 10000); }
process.on('SIGINT', gracefulShutdown); process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (e, o) => { log(`💥 Uncaught Exception: ${e.message} at ${o}\n${e.stack}`); gracefulShutdown().catch(()=>process.exit(1)); });
process.on('unhandledRejection', (r, p) => { log(`💥 Unhandled Rejection: ${r} at ${p}`); });

// --- Start Server ---
log("🏁 Script parsed. Starting server...");
server.listen(HTTP_PORT, async () => { log(`🚀 Server listening on port ${HTTP_PORT}`); log("   Calling initializeExistingSessions..."); await initializeExistingSessions(); log("   initializeExistingSessions() done."); log("   Setting up cleanup..."); setInterval(() => cleanupOldItems(RECORDINGS_DIR, 24 * 36e5, "rec"), 6 * 36e5); setInterval(() => cleanupOldItems(UPLOADS_DIR, 48 * 36e5, "upld"), 12 * 36e5); log("✅ Server startup sequence complete."); });

// --- Handle WebSocket Upgrades (with Auth) ---
server.on('upgrade', async (request, socket, head) => { let userId = null; let token = null; try { const parsedUrl = new URL(request.url, `http://${request.headers.host}`); token = parsedUrl.searchParams.get('token'); if (!token) throw new Error('No token'); const { data: { user }, error: userError } = await supabase.auth.getUser(token); if (userError) throw userError; if (!user) throw new Error('User not found'); userId = user.id; wss.handleUpgrade(request, socket, head, (ws) => { ws.userId = userId; wss.emit('connection', ws, request); }); } catch (e) { log(`🚫 WS Upgrade Rejected: ${e.message}`); let code = 401, msg = 'Unauthorized'; if (e.message.includes('expired')) msg = 'Token Expired'; else if (e.message.includes('invalid') || e.message.includes('User not found')) { code = 403; msg = 'Forbidden'; } else if (e.message === 'No token provided') msg = 'Token Required'; const resp = `HTTP/1.1 ${code} ${msg}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${msg}`; try { socket.write(resp); } catch (socketError) { console.error("Error writing reject to socket:", socketError); } socket.destroy(); } });

log("🏁 End of script file execution setup.");
// --- END OF FILE ---