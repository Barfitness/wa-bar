// --- Constants & Configuration ---
const CONFIG = {
  refreshInterval: 5000,
  serverUrl: 'ws://localhost:8080', // Base WebSocket URL (token will be added)
  uploadUrl: '/upload',
  uploadAudioUrl: '/upload-audio',
  reconnectAttempts: 5,
  reconnectInterval: 3000,
  maxUploadSize: 64 * 1024 * 1024, // 64MB
  defaultVoiceRecordingLength: 300 // Max recording length in seconds (5 minutes)
};

// --- Supabase Configuration ---
const SUPABASE_URL = 'https://ibulycuxqzlcuvkmetik.supabase.co'; // Replace with your actual URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlidWx5Y3V4cXpsY3V2a21ldGlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQxMzEzNTUsImV4cCI6MjA1OTcwNzM1NX0.3KXJNMTx8I1cOjj6ThNLazdd7taMb-wK8MUzfA63JrY'; // Replace with your actual Anon Key
let supabase; // Initialized in initializeAuth

// --- Global Variables ---
let socket;
let allChatData = {}; // { sessionId: { id, name, chats: { chatId: [messages] }, status, lastMsgTs } }
let activeSessionId = null;
let activeChatId = null;
let blacklistedNumbers = {}; // { normPhone: muteUntilTimestamp | null }
let chatLabels = {}; // { sessionId: { chatId: "labelKey" } }
let searchTerm = '';
let reconnectCount = 0;
let isConnected = false;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimerInterval;
let recordedAudioMimeType = 'audio/webm'; // Default, updated on recording start
let isRecordingCancelled = false;
let emoji = {}; // Loaded emojis
let savedMessages = {}; // { "sessionId-chatId": [{ content, timestamp }] }
let pinnedChats = new Set(); // Set of pinned chatIds (used for Favorites filter)
let contactNames = {}; // { normPhone: { name: '...', field: '...', notes: '...' } }
let unreadMessages = {}; // { sessionId: { chatId: count } }
let notificationSound;
let messageSearchTerm = '';
let messageSearchResults = [];
let currentSearchResultIndex = -1;
let isAiEnabled = true;
const ongoingUploads = new Map(); // Map<tempId, { xhr, file, duration? }>
let recognition; // Speech Recognition instance
let isListening = false; // Speech Recognition state
let activeChatFilter = 'all'; // 'all', 'unread', 'favorite'

// Default AI Settings (Client-side fallback, might differ from server)
const DEFAULT_AI_SETTINGS = {
  ai_instructions: '',
  ai_model: 'gpt-4o-mini',
  ai_temperature: 0.4,
  ai_max_tokens: 300,
  ai_delay_seconds: 5
};

// --- DOM Elements ---
const initialLoader = document.getElementById('initial-loader');
const loginPage = document.getElementById('login-page');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginEmailInput = document.getElementById('login-email');
const loginPasswordInput = document.getElementById('login-password');
const loginButton = document.getElementById('login-button');
const registerEmailInput = document.getElementById('register-email');
const registerPasswordInput = document.getElementById('register-password');
const registerConfirmPasswordInput = document.getElementById('register-confirm-password');
const registerButton = document.getElementById('register-button');
const toggleFormLink = document.getElementById('toggle-form-link');
const authErrorMessage = document.getElementById('auth-error-message');
const mainAppContainer = document.getElementById('main-container');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const powerBtn = document.getElementById('power-btn');
const aiToggleBtn = document.getElementById('ai-toggle-btn');
const settingsBtn = document.getElementById('settings-btn');
const chatsContainer = document.getElementById('chats-container');
const chatArea = document.getElementById('chat-area');
const sidebar = document.getElementById('sidebar');
const chatMessages = document.getElementById('chat-messages');
const emptyState = document.getElementById('empty-state');
const chatHeaderName = document.getElementById('chat-header-name');
const chatHeaderPhone = document.getElementById('chat-header-phone'); // Ensure this exists in HTML
const chatSessionIndicator = document.getElementById('chat-session-indicator');
const chatHeaderLabel = document.getElementById('chat-header-label');
const chatStatus = document.getElementById('chat-status');
const chatAvatar = document.getElementById('chat-avatar');
const muteButton = document.getElementById('mute-button');
const muteInterface = document.getElementById('mute-interface');
const muteName = document.getElementById('mute-name');
const muteCancel = document.getElementById('mute-cancel');
const muteConfirm = document.getElementById('mute-confirm');
const searchInput = document.getElementById('search-input');
const chatInput = document.getElementById('chat-input');
const backButton = document.getElementById('back-button');
const toastContainer = document.getElementById('toast-container');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPanel = document.getElementById('emoji-panel');
const emojiGrid = document.getElementById('emoji-grid');
const attachmentBtn = document.getElementById('attachment-btn');
const fileUploadPanel = document.getElementById('file-upload-panel');
const voiceBtn = document.getElementById('voice-btn');
const recordingUI = document.getElementById('recording-ui');
const recordingTimer = document.getElementById('recording-timer');
const stopRecordingBtn = document.getElementById('stop-recording-btn');
const sendRecordingBtn = document.getElementById('send-recording-btn');
const cancelRecordingBtn = document.getElementById('cancel-recording-btn');
const photoUpload = document.getElementById('photo-upload');
const videoUpload = document.getElementById('video-upload');
const documentUpload = document.getElementById('document-upload');
const audioUpload = document.getElementById('audio-upload');
const searchChatBtn = document.getElementById('search-chat-btn');
const searchMessageContainer = document.getElementById('search-message-container');
const searchMessageInput = document.getElementById('search-message-input');
const closeSearchMsgBtn = document.getElementById('close-search-msg-btn');
const searchPrevBtn = document.getElementById('search-prev-btn');
const searchNextBtn = document.getElementById('search-next-btn');
const searchResultCount = document.getElementById('search-result-count');
const messageContextMenu = document.getElementById('message-context-menu');
const chatContextMenu = document.getElementById('chat-context-menu');
const labelSelectionMenu = document.getElementById('label-selection-menu');
const chatActionsButton = document.getElementById('chat-options-btn');
const chatActionsMenu = document.getElementById('chat-actions-menu');

// Filter Buttons
const filterAllBtn = document.getElementById('filter-all-btn');
const filterUnreadBtn = document.getElementById('filter-unread-btn');
const filterFavoriteBtn = document.getElementById('filter-favorite-btn'); // Assuming favorite = pinned

// Settings Modal Elements
const settingsModal = document.getElementById('settings-modal');
const settingsModalCloseBtn = document.getElementById('settings-modal-close');
const aiInstructionsInput = document.getElementById('ai-instructions');
const aiModelSelect = document.getElementById('ai-model');
const aiTemperatureInput = document.getElementById('ai-temperature');
const aiMaxTokensInput = document.getElementById('ai-max-tokens');
const aiDelayInput = document.getElementById('ai-delay');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');

// QR Code Modal Elements
const qrModal = document.getElementById('qr-modal');
const qrCodeImg = document.getElementById('qr-code-img');
const qrSessionNameSpan = document.getElementById('qr-session-name');
const qrModalCloseBtn = document.getElementById('qr-modal-close');
const qrLoadingDiv = document.getElementById('qr-loading');

// Contact Info Modal Elements
const contactInfoModal = document.getElementById('contact-info-modal');
const contactInfoModalCloseBtn = document.getElementById('contact-info-modal-close');
const contactInfoNameInput = document.getElementById('contact-info-name');
const contactInfoFieldInput = document.getElementById('contact-info-field');
const contactInfoPhoneSpan = document.getElementById('contact-info-phone');
const contactInfoLabelSelect = document.getElementById('contact-info-label');
const contactInfoNotesTextarea = document.getElementById('contact-info-notes');
const saveContactInfoBtn = document.getElementById('save-contact-info-btn');
const contactInfoScheduledCallDiv = document.getElementById('contact-info-scheduled-call');


// --- Utility & Helper Functions ---
function showLoading(button) { if (!button) return; button.disabled = true; const text = button.querySelector('.button-text'); const icon = button.querySelector('.loading-icon'); if (text) text.style.display = 'none'; if (icon) icon.style.display = 'inline-block'; }
function hideLoading(button) { if (!button) return; button.disabled = false; const text = button.querySelector('.button-text'); const icon = button.querySelector('.loading-icon'); if (text) text.style.display = 'inline-block'; if (icon) icon.style.display = 'none'; }
function displayAuthError(message) { if (authErrorMessage) { authErrorMessage.textContent = message; authErrorMessage.style.display = 'block'; } }
function clearAuthError() { if (authErrorMessage) { authErrorMessage.textContent = ''; authErrorMessage.style.display = 'none'; } }
function getFriendlyErrorMessage(error) { if (!error?.message) return "שגיאה לא ידועה."; const msg = error.message.toLowerCase(); if (msg.includes("invalid login credentials")) return "אימייל/סיסמה שגויים."; if (msg.includes("user already registered")) return "משתמש כבר רשום."; if (msg.includes("password should be at least 6 characters")) return "סיסמה קצרה מדי (מינימום 6 תווים)."; if (msg.includes("unable to validate email") || msg.includes("invalid email")) return "כתובת אימייל לא תקינה."; if (msg.includes("rate limit exceeded") || msg.includes("too many requests")) return "יותר מדי בקשות. נסה מאוחר יותר."; if (msg.includes("network error") || msg.includes("failed to fetch")) return "שגיאת רשת. בדוק חיבור."; if (msg.includes("confirmation required")) return "נדרש אישור אימייל."; if (msg.includes("validation failed") && msg.includes("confirm_password")) return "הסיסמאות אינן תואמות."; console.error("Unhandled Auth Error:", error); return "שגיאת אימות. נסה שוב."; }
function formatTime(date) { if (!(date instanceof Date)) date = new Date(date); return date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); }
function shortenText(text, maxLength) { text = String(text || ''); return text.length <= maxLength ? text : text.substring(0, maxLength) + '...'; }
function formatFileSize(bytes) { if (bytes == null || isNaN(bytes) || bytes < 0) return ''; if (bytes === 0) return '0 Bytes'; const k = 1024; const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']; const i = Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))); return parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)) + ' ' + sizes[i]; }
function getLastMessage(messages) { return (messages?.length > 0) ? messages[messages.length - 1] : null; }
function getLastMessageTimestamp(messages) { return getLastMessage(messages)?.timestamp || 0; }
function getFileIconHTML(fileType) { let icon = 'fa-file'; switch(fileType?.toLowerCase()){ case 'image': icon = 'fa-image'; break; case 'video': icon = 'fa-video'; break; case 'audio': icon = 'fa-music'; break; case 'pdf': icon = 'fa-file-pdf'; break; case 'word': case 'doc': case 'docx': icon = 'fa-file-word'; break; case 'excel': case 'xls': case 'xlsx': icon = 'fa-file-excel'; break; case 'powerpoint': case 'ppt': case 'pptx': icon = 'fa-file-powerpoint'; break; case 'archive': case 'zip': case 'rar': case '7z': icon = 'fa-file-archive'; break; case 'text': case 'txt': case 'csv': icon = 'fa-file-alt'; break; case 'document': icon = 'fa-file-alt'; break; } return `<i class="fas ${icon}"></i>`; }
function linkify(text) { text = String(text || ''); const urlRegex = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\b[-A-Z0-9+&@#\/%?=~_|!:,.;]+\.(com|org|net|gov|edu|io|co|il|ai|dev|app)\b)|(\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/ig; return text.replace(urlRegex, function(match) { let url = match; let displayUrl = match; if (!match.match(/^[a-zA-Z]+:/) && !match.startsWith('www.') && !match.includes('@')) url = 'http://' + match; else if (match.toLowerCase().startsWith('www.')) url = 'http://' + match; else if (match.includes('@')) url = 'mailto:' + match; if (displayUrl.length > 50 && !displayUrl.startsWith('mailto:')) displayUrl = displayUrl.substring(0, 47) + '...'; if (url.toLowerCase().startsWith('javascript:')) return match; return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: #007bff; text-decoration: underline;">${displayUrl}</a>`; }); }
function placeCaretAtEnd(el) { el.focus(); if (window.getSelection && document.createRange) { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } else if (document.body.createTextRange) { const textRange = document.body.createTextRange(); textRange.moveToElementText(el); textRange.collapse(false); textRange.select(); } }
function normalizePhoneNumber(phoneNumber) { if (!phoneNumber) return ''; let n = phoneNumber.replace(/\D/g, ''); if (n.length > 9 && n.startsWith('972')) {} else if (n.length === 10 && n.startsWith('05')) n = '972' + n.substring(1); else if (n.length === 9 && !n.startsWith('0')) n = '972' + n; return n; }
function formatPhoneNumber(phoneNumber) { if (!phoneNumber) return ''; const c = phoneNumber.replace(/\D/g, ''); if (c.startsWith('972')) { const l = c.substring(3); if (l.length === 9 && l.startsWith('5')) return `0${l.substring(0,2)}-${l.substring(2,5)}-${l.substring(5)}`; if (l.length === 8) return `0${l.substring(0,1)}-${l.substring(1,4)}-${l.substring(4)}`; } return `+${c}`; }
function getContactDisplayInfo(phoneNumber) {
  if (!phoneNumber) return { name: '', field: '', phone: '' };
  const norm = normalizePhoneNumber(phoneNumber);
  const contact = contactNames[norm];
  const formattedPhone = formatPhoneNumber(norm);
  // Ensure name defaults to formattedPhone if contact.name is empty/null
  return { name: contact?.name || formattedPhone, field: contact?.field || '', phone: formattedPhone };
}
function showToast(message, type = 'info', duration = 3000) { if (!toastContainer) return; const toast = document.createElement('div'); toast.className = `toast ${type}`; let icon = 'fa-info-circle'; if (type === 'success') icon = 'fa-check-circle'; if (type === 'error') icon = 'fa-exclamation-circle'; const msgDiv = document.createElement('div'); msgDiv.textContent = message; const iconEl = document.createElement('i'); iconEl.className = `fas ${icon}`; toast.append(iconEl, msgDiv); toastContainer.prepend(toast); const timer = setTimeout(() => removeToast(toast), duration); toast.dataset.timerId = timer.toString(); toast.onclick = (e) => removeToast(toast); }
function removeToast(toastEl) { if (!toastEl?.parentNode) return; const timer = toastEl.dataset.timerId; if (timer) clearTimeout(parseInt(timer)); toastEl.style.opacity = '0'; toastEl.style.transition = 'opacity 0.5s ease-out'; setTimeout(() => toastEl.remove(), 500); }
function addCancelOptionToFilePreview(previewElement, tempId) { if (!previewElement || previewElement.querySelector('.upload-cancel-option')) return; const btn = document.createElement('div'); btn.className = 'upload-cancel-option'; btn.innerHTML = '<i class="fas fa-times"></i>'; btn.title = 'בטל העלאה'; btn.onclick = (e) => { e.stopPropagation(); cancelUpload(tempId); }; previewElement.style.position = 'relative'; previewElement.appendChild(btn); }
function updateOptimisticMessageState(tempId, { error = false, errorMessage = '', sent = false, finalId = null, finalTimestamp = null }) { const el = document.getElementById(tempId); if (!el) { console.warn(`Cannot update state for non-existent tempId: ${tempId}`); return; } let msgUpdated = false; Object.keys(allChatData).forEach(sid => { if (msgUpdated) return; Object.keys(allChatData[sid].chats || {}).forEach(cid => { if (msgUpdated) return; const msgs = allChatData[sid].chats[cid]; const idx = msgs?.findIndex(m => m.tempId === tempId); if (idx > -1) { msgs[idx].optimistic = false; msgs[idx].error = error; if (errorMessage) msgs[idx].errorMessage = errorMessage; if (finalId) msgs[idx].id = finalId; if (finalTimestamp) msgs[idx].timestamp = finalTimestamp; msgUpdated = true; } }); }); if (!msgUpdated) console.warn(`Could not find message data for tempId: ${tempId}`); el.removeAttribute('data-uploading'); el.querySelector('.upload-progress')?.remove(); el.querySelector('.upload-cancel-option')?.remove(); if (finalId) el.id = `msg-${finalId}`; const timeEl = el.querySelector('.message-time, .file-preview-time'); if (timeEl) { timeEl.querySelector('.fa-clock')?.remove(); const errIconExisting = timeEl.querySelector('.fa-exclamation-circle'); if (error && !errIconExisting) { const errIcon = document.createElement('i'); errIcon.className = 'fas fa-exclamation-circle'; errIcon.style.color = 'var(--error-color)'; errIcon.style.marginRight = '3px'; errIcon.style.fontSize = '0.7em'; errIcon.title = errorMessage || 'שגיאת שליחה'; timeEl.appendChild(errIcon); el.classList.add('upload-error'); } else if (!error && errIconExisting) { errIconExisting.remove(); el.classList.remove('upload-error'); } if (finalTimestamp) { const timeNode = timeEl.childNodes[0]; if (timeNode?.nodeType === Node.TEXT_NODE) timeNode.nodeValue = formatTime(new Date(finalTimestamp)); const tsAttr = timeEl.closest('[data-timestamp]'); if (tsAttr) tsAttr.dataset.timestamp = finalTimestamp; } } }
function getLabelInfo(labelKey) { switch (labelKey) { case 'new': return { text: 'חדש', colorClass: 'blue' }; case 'inprogress': return { text: 'בתהליך', colorClass: 'orange' }; case 'paid': return { text: 'שולם', colorClass: 'green' }; case 'waiting': return { text: 'ממתין', colorClass: 'purple' }; case 'notinterested': return { text: 'לא מעוניין', colorClass: 'red' }; default: return { text: labelKey || 'לא ידוע', colorClass: 'grey' }; } }

// --- Emojis ---
function loadEmojis() { emoji = { smileys: ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬'], people: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦵','🦿','🦶','👂','🦻','👃','🧠','👣','👀','👁️','👅','👄','💋','🩸'], animals: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🕸️','🦂','🦞','🦐','🦑','🦀'], food: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈'], travel: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🛺','🚲','🛴','🛹','🛼','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩️','💺','🛰️','🚀','🛸','🚁','🛶','⛵','🚤','🛥️','🛳️'], activities: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂','🏋️','🤼','🤸','⛹️'], objects: ['⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋'], symbols: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐'] }; displayEmojiCategory('smileys'); }
function displayEmojiCategory(cat) { if (!emojiGrid) return; emojiGrid.innerHTML = ''; (emoji[cat] || []).forEach(em => { const item = document.createElement('div'); item.className = 'emoji-item'; item.textContent = em; item.onclick = () => insertEmoji(em); emojiGrid.appendChild(item); }); }
function insertEmoji(em) { if (!chatInput) return; chatInput.focus(); document.execCommand('insertText', false, em); }
function toggleEmojiPanel() { if (emojiPanel) { emojiPanel.classList.toggle('visible'); if (fileUploadPanel) fileUploadPanel.classList.remove('visible'); if (recordingUI) recordingUI.classList.remove('visible'); if (muteInterface) muteInterface.classList.remove('visible'); } }
function toggleFileUploadPanel() { if (fileUploadPanel) { fileUploadPanel.classList.toggle('visible'); if (emojiPanel) emojiPanel.classList.remove('visible'); if (recordingUI) recordingUI.classList.remove('visible'); if (muteInterface) muteInterface.classList.remove('visible'); } }

// --- Supabase & Auth Logic ---
function initializeAuth() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR_URL') || SUPABASE_ANON_KEY.includes('YOUR_KEY')) { console.error("Supabase config missing!"); displayAuthError("שגיאת תצורה."); if(initialLoader) initialLoader.style.display = 'none'; if (loginPage) loginPage.style.display = 'flex'; return; }
  try { supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
  catch (error) { console.error("Supabase init failed:", error); displayAuthError("שגיאה בחיבור לאימות."); if(initialLoader) initialLoader.style.display = 'none'; if (loginPage) loginPage.style.display = 'flex'; return; }
  supabase.auth.getSession().then(({ data: { session }, error }) => { if (error) { console.error("Get session error:", error); if(initialLoader) initialLoader.style.display = 'none'; if (loginPage) loginPage.style.display = 'flex'; } else if (session) { console.log('User logged in.'); localStorage.setItem('supabaseToken', session.access_token); showMainApp(); } else { console.log('User not logged in.'); if(initialLoader) initialLoader.style.display = 'none'; if (loginPage) loginPage.style.display = 'flex'; } }).catch(err => { console.error("Catch get session error:", err); if(initialLoader) initialLoader.style.display = 'none'; if (loginPage) loginPage.style.display = 'flex'; });
  loginForm?.addEventListener('submit', async (e) => { e.preventDefault(); clearAuthError(); showLoading(loginButton); try { const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmailInput.value, password: loginPasswordInput.value }); if (error) throw error; if (data.session) { localStorage.setItem('supabaseToken', data.session.access_token); showMainApp(); } else throw new Error("No session after login."); } catch (error) { console.error('Login error:', error); displayAuthError(getFriendlyErrorMessage(error)); } finally { hideLoading(loginButton); } });
  registerForm?.addEventListener('submit', async (e) => { e.preventDefault(); clearAuthError(); const pwd = registerPasswordInput.value; if (pwd !== registerConfirmPasswordInput.value) { displayAuthError("סיסמאות לא תואמות."); return; } if (pwd.length < 6) { displayAuthError("סיסמה קצרה מדי."); return; } showLoading(registerButton); try { const { data, error } = await supabase.auth.signUp({ email: registerEmailInput.value, password: pwd }); if (error) { if (error.message?.toLowerCase().includes("signups not allowed")) displayAuthError("הרשמה לא מאופשרת."); else throw error; } else if (data.user && !data.session) { alert("הרשמה הצליחה! בדוק אימייל לאישור הכתובת והתחבר."); loginForm.style.display = 'block'; registerForm.style.display = 'none'; toggleFormLink.textContent = 'אין לך חשבון? הירשם'; registerForm.reset(); } else if (data.session) { localStorage.setItem('supabaseToken', data.session.access_token); showMainApp(); } else { console.warn("Signup unexpected response:", data); alert("הרשמה הצליחה. ייתכן שתצטרך להתחבר."); loginForm.style.display = 'block'; registerForm.style.display = 'none'; toggleFormLink.textContent = 'אין לך חשבון? הירשם'; registerForm.reset(); } } catch (error) { console.error('Signup error:', error); displayAuthError(getFriendlyErrorMessage(error)); } finally { hideLoading(registerButton); } });
  toggleFormLink?.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (loginForm.style.display === 'none') { loginForm.style.display = 'block'; registerForm.style.display = 'none'; toggleFormLink.textContent = 'אין לך חשבון? הירשם'; } else { loginForm.style.display = 'none'; registerForm.style.display = 'block'; toggleFormLink.textContent = 'כבר יש לך חשבון? התחבר'; } });
}

function showMainApp() {
  if (loginPage) { loginPage.classList.add('hidden'); setTimeout(() => { if(loginPage) loginPage.style.display = 'none'; }, 500); }
  if (mainAppContainer) mainAppContainer.style.display = 'flex';
  if(initialLoader) initialLoader.style.display = 'none';
  initializeMainAppComponents();
}

function initializeMainAppComponents() {
  console.log("Initializing main app components...");
  loadEmojis(); loadSavedData(); loadContactNames(); loadAiState(); initializeNotifications();
  powerBtn?.addEventListener('click', toggleConnection);
  aiToggleBtn?.addEventListener('click', toggleAiState);
  settingsBtn?.addEventListener('click', openSettingsModal);
  searchInput?.addEventListener('input', handleSearch);
  muteButton?.addEventListener('click', showMuteInterface);
  muteCancel?.addEventListener('click', hideMuteInterface);
  muteConfirm?.addEventListener('click', muteCurrentChat);
  backButton?.addEventListener('click', showSidebar);
  chatInput?.addEventListener('keydown', handleChatInput);
  emojiBtn?.addEventListener('click', toggleEmojiPanel);
  attachmentBtn?.addEventListener('click', toggleFileUploadPanel);
  voiceBtn?.addEventListener('click', startRecording); // Single click for recording
  voiceBtn?.addEventListener('dblclick', toggleSpeechRecognition); // Double click for dictation
  stopRecordingBtn?.addEventListener('click', stopRecording);
  sendRecordingBtn?.addEventListener('click', sendRecording);
  cancelRecordingBtn?.addEventListener('click', cancelRecording);
  photoUpload?.addEventListener('change', handleFileUpload);
  videoUpload?.addEventListener('change', handleFileUpload);
  documentUpload?.addEventListener('change', handleFileUpload);
  audioUpload?.addEventListener('change', handleFileUpload);
  document.getElementById('photo-option')?.addEventListener('click', () => photoUpload?.click());
  document.getElementById('video-option')?.addEventListener('click', () => videoUpload?.click());
  document.getElementById('document-option')?.addEventListener('click', () => documentUpload?.click());
  document.getElementById('audio-option')?.addEventListener('click', () => audioUpload?.click());
  document.getElementById('contact-option')?.addEventListener('click', () => showToast('Contact sending not implemented.', 'info'));
  document.getElementById('location-option')?.addEventListener('click', () => showToast('Location sending not implemented.', 'info'));
  document.querySelectorAll('.emoji-category').forEach(cat => { cat.onclick = function() { document.querySelectorAll('.emoji-category').forEach(el => el.classList.remove('active')); this.classList.add('active'); displayEmojiCategory(this.dataset.category); }; });
  setupContextMenus(); setupMessageSearch(); initSpeechRecognition(); setupChatActionsMenu(); setupSettingsModal(); setupQrModal();
  setupContactInfoModal();
  setupChatFilters(); // Initialize filter button listeners
  const logoutBtn = document.querySelector('.logout-btn');
  if (logoutBtn && !logoutBtn.dataset.listenerAttached) { logoutBtn.onclick = handleLogout; logoutBtn.dataset.listenerAttached = 'true'; }
  const headerInfoDiv = document.querySelector('.chat-header-info');
  if (headerInfoDiv) { headerInfoDiv.style.cursor = 'pointer'; headerInfoDiv.onclick = () => { if (activeChatId && activeSessionId) { openContactInfoModal(activeChatId.replace(/@c\.us$/, '')); } }; }
  initConnection();
  console.log("Main application components initialized.");
}

// --- Logout Functionality ---
function handleLogout() { if (!supabase) return; const token = localStorage.getItem('supabaseToken'); if (!token) { showLoginPage(); return; } console.log("Logging out..."); supabase.auth.signOut().then(() => { console.log("SignOut OK"); cleanupAfterLogout(); showToast('התנתקת בהצלחה', 'success'); }).catch(error => { console.error('Logout error:', error); showToast('שגיאה בהתנתקות: ' + error.message, 'error'); cleanupAfterLogout(); }); }
function cleanupAfterLogout() { localStorage.removeItem('supabaseToken'); localStorage.removeItem('contactNamesV2'); localStorage.removeItem('pinnedChats'); localStorage.removeItem('savedMessages'); allChatData={}; chatLabels={}; activeChatId=null; activeSessionId=null; pinnedChats=new Set(); savedMessages={}; contactNames={}; unreadMessages={}; searchTerm=''; if(searchInput)searchInput.value=''; if(chatInput)chatInput.innerHTML=''; if (socket?.readyState===WebSocket.OPEN) socket.close(); else { updateConnectionStatus('מנותק', 'disconnected'); if(chatsContainer)chatsContainer.innerHTML=''; showEmptyState(); } showLoginPage(); }
function showLoginPage() { if (mainAppContainer) mainAppContainer.style.display = 'none'; if (loginPage) { loginPage.classList.remove('hidden'); loginPage.style.display = 'flex'; loginForm?.reset(); registerForm?.reset(); clearAuthError(); if (registerForm) registerForm.style.display = 'none'; if (loginForm) loginForm.style.display = 'block'; if (toggleFormLink) toggleFormLink.textContent = 'אין לך חשבון? הירשם'; } }

// --- WebSocket Communication ---
function initConnection() { const token = localStorage.getItem('supabaseToken'); if (!token) { showToast('אימות נדרש.', 'error'); handleLogout(); return; } if (socket?.readyState === WebSocket.OPEN) { return; } updateConnectionStatus('מתחבר...', 'connecting'); if(powerBtn) powerBtn.disabled = true; const wsUrl = `${CONFIG.serverUrl}?token=${encodeURIComponent(token)}`; console.log(`Connecting to WS: ${wsUrl}`); try { socket = new WebSocket(wsUrl); socket.onopen = () => { isConnected = true; reconnectCount = 0; updateConnectionStatus('מחובר', 'connected'); showToast('חיבור לשרת הצליח', 'success'); if(powerBtn) powerBtn.disabled = false; sendSocketMessage({ type: 'requestInitialData' }); }; socket.onmessage = (ev) => handleSocketMessage(ev.data); socket.onclose = (ev) => { isConnected = false; updateConnectionStatus('מנותק', 'disconnected'); if(powerBtn) powerBtn.disabled = false; if (ev.code === 4001 || ev.reason.includes('expired') || ev.reason.includes('Invalid')) { showToast('אימות נכשל/פג. נדרש להתחבר מחדש.', 'error'); handleLogout(); } else if (reconnectCount < CONFIG.reconnectAttempts) { reconnectCount++; showToast(`התנתק. מנסה מחדש (${reconnectCount}/${CONFIG.reconnectAttempts})`, 'error'); setTimeout(initConnection, CONFIG.reconnectInterval); } else { showToast('התנתקות מהשרת. נסיונות חיבור נכשלו.', 'error'); reconnectCount = 0; } }; socket.onerror = (err) => { console.error('WS error:', err); if (!isConnected) { showToast('שגיאת חיבור לשרת', 'error'); updateConnectionStatus('מנותק', 'disconnected'); if(powerBtn) powerBtn.disabled = false; } }; } catch (error) { console.error('WS init error:', error); showToast('שגיאה ביצירת חיבור', 'error'); updateConnectionStatus('מנותק', 'disconnected'); if(powerBtn) powerBtn.disabled = false; } }
function closeConnection() { if (socket?.readyState === WebSocket.OPEN) { if(powerBtn) powerBtn.disabled = true; reconnectCount = CONFIG.reconnectAttempts; socket.close(); showToast('ניתוק יזום', 'info'); } else showToast('כבר מנותק', 'info'); }
function toggleConnection() { if (isConnected) closeConnection(); else initConnection(); }
function sendSocketMessage(message) { if (!socket || socket.readyState !== WebSocket.OPEN) { showToast('לא מחובר לשרת', 'error'); if (!isConnected && reconnectCount < CONFIG.reconnectAttempts) initConnection(); return false; } try { const msgString = JSON.stringify(message); console.log('[WS Send]:', msgString.substring(0, 500)); socket.send(msgString); return true; } catch (error) { console.error('WS send error:', error); showToast('שגיאה בשליחת הודעה', 'error'); return false; } }
function handleSocketMessage(data) { try { const msg = JSON.parse(data); console.log('[WS Received]:', msg.type, msg.sessionId || '', msg.chatId || ''); const sid = msg.sessionId; const cid = msg.chatId; // Define cid here for easier access
      switch (msg.type) { case 'init': allChatData = {}; chatLabels = msg.labels || {}; contactNames = msg.contacts || {}; (msg.sessions||[]).forEach(s => {allChatData[s.id]={id:s.id,name:s.name||s.id,chats:{},status:s.status||'unknown',lastMsgTs:0};}); blacklistedNumbers=msg.blacklist||{}; loadAiSettingsFromInit(msg.settings); renderAllChats(); showToast('נתונים התקבלו', 'success'); break; case 'sessionStatusUpdate': if (sid && allChatData[sid]) { allChatData[sid].status = msg.status; renderAllChats(); const connectedStates = ['CONNECTED','PAIRING','SYNCING','OPENING','TIMEOUT']; if (qrModal?.style.display === 'flex' && qrModal.dataset.sessionId === sid && connectedStates.includes(msg.status.toUpperCase())) { hideQrModal(); showToast(`סשן ${allChatData[sid]?.name || sid} התחבר!`, 'success'); } else if (qrModal?.style.display === 'flex' && qrModal.dataset.sessionId === sid && ['CLOSED','DISCONNECTED','UNPAIRED','CONFLICT','ERROR_CREATE'].includes(msg.status.toUpperCase())) { hideQrModal(); showToast(`חיבור לסשן ${allChatData[sid]?.name || sid} נכשל/נותק.`, 'error'); } } break; case 'qrCode': if (sid) { console.log(`QR received for ${sid}`); showToast(`סרוק QR לסשן ${sid}`, 'info', 15000); showQrModal(sid, msg.qr); } break; case 'muteUpdated': blacklistedNumbers = msg.blacklist || {}; if (activeChatId && activeSessionId) updateChatHeaderMuteStatus(activeSessionId, activeChatId); renderAllChats(); updateMuteActionMenuText(); break; case 'newMessage': handleNewMessage(msg); break; case 'transcription': case 'transcriptionFailed': handleTranscriptionResult(msg); break; case 'historyData': if (!sid || !allChatData[sid] || !cid) break; allChatData[sid].chats[cid] = (msg.messages||[]).map(m=>({...m, role:(m.role==='user'||m.role==='assistant')?m.role:'user'})); allChatData[sid].lastMsgTs = Math.max(allChatData[sid].lastMsgTs || 0, getLastMessageTimestamp(allChatData[sid].chats[cid])); renderAllChats(); if (activeSessionId===sid && activeChatId===cid) renderMessages(sid, cid); break; case 'allChatsHistoryData': if (!sid || !allChatData[sid]) break; const sChats = msg.chats || {}; if (msg.labels) { if (!chatLabels[sid]) chatLabels[sid] = {}; Object.assign(chatLabels[sid], msg.labels); } const procChats = {}; let latestTs = allChatData[sid].lastMsgTs || 0; Object.keys(sChats).forEach(cId => { if (!Array.isArray(sChats[cId])) { if (chatLabels[sid]?.[cId] && !procChats[cId]) { procChats[cId] = []; } return; } procChats[cId] = sChats[cId].map(m=>({...m, role:(m.role==='user'||m.role==='assistant')?m.role:'user'})); const ts = getLastMessageTimestamp(procChats[cId]); if (ts > latestTs) latestTs = ts; }); if (chatLabels[sid]) { Object.keys(chatLabels[sid]).forEach(cId => { if (!procChats[cId]) { procChats[cId] = []; } }); } allChatData[sid].chats = procChats; allChatData[sid].lastMsgTs = latestTs; renderAllChats(); if (activeSessionId===sid && activeChatId && procChats[activeChatId]) renderMessages(sid, activeChatId); break; case 'messageSent': case 'fileSent': case 'voiceSent': updateOptimisticMessageState(msg.tempId, { sent: true, finalId: msg.messageId, finalTimestamp: msg.timestamp }); break; case 'messageSendError': case 'fileSendError': case 'voiceSendError': showToast(`שגיאת שליחה: ${msg.error || 'Unknown'}`, 'error'); updateOptimisticMessageState(msg.tempId, { error: true, errorMessage: msg.error || 'Send error' }); break; case 'aiSettingsUpdated': showToast(msg.success ? 'הגדרות AI עודכנו' : `שגיאה בעדכון הגדרות: ${msg.error}`, msg.success ? 'success' : 'error'); if (msg.success) { sendSocketMessage({type: 'getAiSettings'}); } break; case 'aiSettingsData': loadAiSettingsFromInit(msg.settings); break; case 'labelUpdated': const { chatId: lChatId, label: lLabel } = msg; if (sid && lChatId && lLabel) { if (!chatLabels[sid]) chatLabels[sid] = {}; chatLabels[sid][lChatId] = lLabel; showToast(`תגית של ${getContactDisplayInfo(lChatId.replace(/@c\.us$/,'')).name} שונתה ל: ${getLabelInfo(lLabel).text}`, 'info'); renderAllChats(); if (activeSessionId === sid && activeChatId === lChatId) { updateChatHeaderLabel(lLabel); updateContactInfoModalIfNeeded(); } } break;
          case 'contactUpdated': const { phoneNumber: cuPhone, details: cuDetails } = msg; if (cuPhone && cuDetails) { const normPhone = normalizePhoneNumber(cuPhone); if (!contactNames[normPhone]) contactNames[normPhone] = {}; if (cuDetails.hasOwnProperty('contact_name')) contactNames[normPhone].name = cuDetails.contact_name; if (cuDetails.hasOwnProperty('business_field')) contactNames[normPhone].field = cuDetails.business_field; if (cuDetails.hasOwnProperty('notes')) contactNames[normPhone].notes = cuDetails.notes; saveContactNames(); showToast(`פרטי קשר עודכנו עבור ${contactNames[normPhone].name || formatPhoneNumber(normPhone)}`, 'success'); renderAllChats(); if (activeChatId && normalizePhoneNumber(activeChatId.replace(/@c\.us$/,'')) === normPhone) { updateChatHeaderDisplay(); updateContactInfoModalIfNeeded(); } } break;
          case 'callScheduled': case 'callUpdated': const { chatId: callChatId, details: callDetails } = msg; if (sid && callChatId && callDetails) { showToast(`שיחה נקבעה/עודכנה עבור ${getContactDisplayInfo(callChatId.replace(/@c.us$/,'')).name}: ${callDetails.requested_time_text}`, 'info'); updateContactInfoModalIfNeeded(); } break;
          case 'scheduledCallData': // Handle received call info for modal
              const { chatId: scChatId, callInfo: scCallInfo } = msg;
              if (sid === activeSessionId && scChatId === activeChatId && contactInfoModal?.style.display === 'flex' && contactInfoScheduledCallDiv) {
                  if (scCallInfo) {
                       contactInfoScheduledCallDiv.textContent = `${scCallInfo.status === 'pending' ? 'בהמתנה' : scCallInfo.status}: ${scCallInfo.requested_time_text}`;
                       // TODO: Add button to mark as completed if status is 'pending'
                  } else {
                       contactInfoScheduledCallDiv.textContent = "(אין שיחה קבועה)";
                  }
              }
              break;
          // --- NEW: Handle Full History Loading States ---
          case 'fullHistoryLoading':
              if (sid === activeSessionId && cid === activeChatId) {
                  const loadingDiv = document.getElementById('history-loader');
                  if (loadingDiv) {
                       loadingDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> טוען היסטוריה מלאה...`;
                       loadingDiv.style.display = 'block';
                  }
                  const btn = document.querySelector('.load-full-history-btn');
                  if (btn) btn.style.display = 'none'; // Hide button while loading
              }
              break;
          case 'fullHistoryData':
              if (sid === activeSessionId && cid === activeChatId) {
                  if (!allChatData[sid]) allChatData[sid] = { chats: {} };
                  allChatData[sid].chats[cid] = msg.messages || []; // Replace with full history
                  allChatData[sid].lastMsgTs = Math.max(allChatData[sid].lastMsgTs || 0, getLastMessageTimestamp(allChatData[sid].chats[cid]));
                  if (chatMessages) chatMessages.dataset.fullHistoryLoaded = "true"; // Mark as loaded
                  renderMessages(sid, cid); // Re-render with full history (will remove button)
                  renderAllChats(); // Update sidebar timestamp/preview if needed
                  showToast(`היסטוריה מלאה נטענה עבור ${getContactDisplayInfo(cid.replace(/@c\.us$/, '')).name}`, 'success');
              } else {
                  // Store history even if chat not active? Optional.
                  if (allChatData[sid] && allChatData[sid].chats) {
                       allChatData[sid].chats[cid] = msg.messages || [];
                       allChatData[sid].lastMsgTs = Math.max(allChatData[sid].lastMsgTs || 0, getLastMessageTimestamp(allChatData[sid].chats[cid]));
                  }
              }
              break;
          case 'fullHistoryError':
               if (sid === activeSessionId && cid === activeChatId) {
                  const loadingDiv = document.getElementById('history-loader');
                  if (loadingDiv) {
                       loadingDiv.innerHTML = `<i class="fas fa-exclamation-circle"></i> שגיאה בטעינת היסטוריה מלאה: ${msg.error || 'Unknown'}`;
                       loadingDiv.style.color = 'var(--error-color)';
                       loadingDiv.style.display = 'block';
                  }
                  const btn = document.querySelector('.load-full-history-btn');
                  if (btn) btn.style.display = 'block'; // Show button again on error
               }
               showToast(`שגיאה בטעינת היסטוריה מלאה: ${msg.error || 'Unknown'}`, 'error');
               break;
          // --- END NEW ---
          default: console.warn('Unhandled WS msg type:', msg.type); } } catch (error) { console.error('WS msg proc error:', error, 'Raw:', data); showToast('שגיאה בעיבוד הודעה מהשרת', 'error'); } }
function handleNewMessage(msg) { const { sessionId: sid, chatId, message: incMsg, phoneNumber } = msg; if (!sid || !allChatData[sid] || !chatId || !incMsg) { console.warn(`Invalid newMessage:`, msg); return; } if (!allChatData[sid].chats) allChatData[sid].chats = {}; if (!allChatData[sid].chats[chatId]) allChatData[sid].chats[chatId] = []; if (incMsg.id && allChatData[sid].chats[chatId].some(m => m.id === incMsg.id)) { console.warn(`Duplicate msg ID ${incMsg.id}. Skipping.`); return; } if (!incMsg.role || (incMsg.role !== 'user' && incMsg.role !== 'assistant')) incMsg.role = 'user'; if (!chatLabels[sid]) chatLabels[sid] = {}; if (!chatLabels[sid][chatId]) chatLabels[sid][chatId] = 'new'; const normPhone = normalizePhoneNumber(chatId.replace(/@c\.us$/, '')); if (!contactNames[normPhone]) contactNames[normPhone] = {}; allChatData[sid].chats[chatId].push(incMsg); allChatData[sid].lastMsgTs = getLastMessageTimestamp(allChatData[sid].chats[chatId]); renderAllChats(); if (activeSessionId === sid && activeChatId === chatId) { renderMessages(sid, chatId); addMessageReceivedAnimation(); } else { updateUnreadCount(sid, chatId); playNotificationSound(); const chatItem = document.querySelector(`.chat-item[data-session-id="${sid}"][data-chat-id="${chatId}"]`); if (chatItem) { chatItem.style.backgroundColor = 'rgba(18, 140, 126, 0.1)'; setTimeout(() => { if(chatItem) chatItem.style.backgroundColor='';}, 2000); } // Only show toast if it's a user message (not bot response)
      if (incMsg.role === 'user') { showToast(`הודעה חדשה מ-${getContactDisplayInfo(phoneNumber).name} (${allChatData[sid]?.name||sid})`, 'info'); } } }
function handleTranscriptionResult(msg) {
  const { sessionId:sid, chatId, originalMessageId, transcript, type, error } = msg;
  if (!sid || !allChatData[sid] || !chatId || !originalMessageId) return;
  const msgs = allChatData[sid].chats?.[chatId];
  if (!msgs) return;
  const idx = msgs.findIndex(m => m.id === originalMessageId);
  if (idx === -1) return;

  const msgToUpd = msgs[idx];
  let updated = false;
  if (type === 'transcription') {
      msgToUpd.content = transcript || '[Empty Transcript]'; // Use transcript as content
      msgToUpd.isVoiceTranscription = true;
      msgToUpd.failed = false;
      updated = true;
  } else if (type === 'transcriptionFailed') {
      msgToUpd.content = `[Voice - Transcr. failed${error?': '+error:''}]`;
      msgToUpd.isVoiceTranscription = true;
      msgToUpd.failed = true;
      updated = true;
  }

  if (updated) {
      renderAllChats(); // Update sidebar preview if needed
      if (activeSessionId === sid && activeChatId === chatId) {
          renderMessages(sid, chatId); // Re-render messages to show the update
      }
  }
}

// --- UI Rendering ---
function updateConnectionStatus(status, state) { if (statusText) statusText.textContent = status; if (statusDot) statusDot.className = `status-dot ${state}`; if (powerBtn) { powerBtn.className = `icon-btn power-btn ${state}`; powerBtn.title = state==='connected'?'התנתק':(state==='connecting'?'מתחבר...':'התחבר'); } }
function renderAllChats() {
  if (!chatsContainer) return;
  chatsContainer.innerHTML = '';
  let allChatsArr = [];
  Object.keys(allChatData).forEach(sid => {
      const s = allChatData[sid];
      // Include chats even if they have no messages yet (from sync)
      if (s.chats) {
          Object.keys(s.chats).forEach(cId => {
              const msgs = s.chats[cId] || []; // Use empty array if messages not loaded yet
              const lastMsg = getLastMessage(msgs);
              const phone = cId.replace(/@c\.us$/, '');
              const contactInfo = getContactDisplayInfo(phone);

              // Apply search filter first
              if (searchTerm && !(phone.includes(searchTerm) || (contactInfo.name || '').toLowerCase().includes(searchTerm.toLowerCase()) || (contactInfo.field || '').toLowerCase().includes(searchTerm.toLowerCase()))) {
                  return; // Skip if doesn't match search term
              }

              const currentLabel = chatLabels[sid]?.[cId] || 'new';
              // Determine timestamp: use last message if available, otherwise 0
              const displayTimestamp = lastMsg ? (lastMsg.timestamp || 0) : 0;

              allChatsArr.push({
                  sid,
                  sName: s.name || sid,
                  cId,
                  phone,
                  msgs, // Keep the messages array (might be empty)
                  lastTs: displayTimestamp, // Use 0 if no messages
                  isPinned: pinnedChats.has(cId), // Pinned = Favorite
                  label: currentLabel,
                  contactInfo,
                  unreadCount: unreadMessages[sid]?.[cId] || 0
              });
          });
      }
  });

  // Apply category filter (unread, favorite)
  let filteredChatsArr = allChatsArr;
  if (activeChatFilter === 'unread') {
      filteredChatsArr = allChatsArr.filter(chat => chat.unreadCount > 0);
  } else if (activeChatFilter === 'favorite') {
      filteredChatsArr = allChatsArr.filter(chat => chat.isPinned);
  }
  // 'all' filter requires no filtering step here

  // Sort the filtered array (pinned first, then by timestamp)
  // Handle chats with timestamp 0 (no messages) - place them after chats with messages
  filteredChatsArr.sort((a, b) => {
      if (a.isPinned !== b.isPinned) {
          return a.isPinned ? -1 : 1; // Pinned first
      }
      if (a.lastTs === 0 && b.lastTs !== 0) return 1; // Chats without messages last
      if (a.lastTs !== 0 && b.lastTs === 0) return -1; // Chats without messages last
      return b.lastTs - a.lastTs; // Sort by timestamp descending
  });

  // Render
  if (filteredChatsArr.length === 0) {
      let emptyMsg = '';
      if (searchTerm) {
          emptyMsg = 'לא נמצאו שיחות התואמות לחיפוש';
      } else if (activeChatFilter === 'unread') {
          emptyMsg = 'אין שיחות שלא נקראו.';
      } else if (activeChatFilter === 'favorite') {
          emptyMsg = 'אין שיחות מועדפות/נעוצות.';
      } else {
          emptyMsg = isConnected ? 'אין צ\'אטים.' : 'לא מחובר.';
      }
       chatsContainer.innerHTML = `<div class="empty-state" style="padding:20px;"><p>${emptyMsg}</p></div>`;
      return;
  }

  filteredChatsArr.forEach(d => renderSingleChatItem(d));
}
function renderSingleChatItem({sid, sName, cId, phone, msgs, isPinned, label, contactInfo, unreadCount}) { // Added unreadCount
  const lastMsg = getLastMessage(msgs); // Might be null if msgs is empty
  let content = '...'; // Default preview
  let iconHTML = '';
  let timeStr = ''; // Default time

  if (lastMsg) {
      timeStr = formatTime(lastMsg.timestamp || Date.now());
      content = lastMsg.content || '';
      if (lastMsg.role === 'assistant') iconHTML = '<i class="fas fa-robot"></i>';
      if (lastMsg.isVoice || content.startsWith('[Voice') || content.includes('Transcription')) {
          content = 'הודעה קולית'; iconHTML += '<i class="fas fa-microphone"></i>';
      } else if (lastMsg.fileType) {
          content = `[${lastMsg.fileType.toUpperCase()}] ${lastMsg.fileName || ''}`; iconHTML += getFileIconHTML(lastMsg.fileType);
      }
  } else {
      // If no messages, show a default preview or nothing
      content = ''; // Empty preview if no messages
  }

  const isMuted = isNumberMuted(phone); let avatar;
  if (cId.endsWith('@g.us')) avatar = '<i class="fas fa-users"></i>'; else if (contactInfo.name !== contactInfo.phone) avatar = contactInfo.name.substring(0, 1).toUpperCase(); else avatar = '<i class="fas fa-user"></i>';
  const item = document.createElement('div'); item.className = `chat-item${isPinned ? ' pinned' : ''}${activeChatId === cId && activeSessionId === sid ? ' active' : ''}`; item.dataset.sessionId = sid; item.dataset.chatId = cId; item.dataset.phoneNumber = phone; const labelInfo = getLabelInfo(label);
  item.innerHTML = `
      ${isPinned ? '<div class="pin-indicator"><i class="fas fa-thumbtack"></i></div>' : ''}
      <div class="chat-avatar ${isMuted ? 'muted' : ''}">${avatar}</div>
      <div class="chat-info">
          <div class="chat-header">
              <div class="chat-name-field">
                  <span class="chat-name">${contactInfo.name}</span>
                  ${contactInfo.field ? `<span class="chat-field">(${contactInfo.field})</span>` : ''}
              </div>
              <div class="chat-time">${timeStr}</div>
          </div>
          <div class="chat-message">
              <span class="chat-label-tag list-label ${labelInfo.colorClass}">${labelInfo.text}</span>
              ${iconHTML}
              <span class="chat-session-label">${sName}</span>
              <span class="chat-preview-text">${shortenText(content, 20)}</span>
              ${unreadCount > 0 ? `<div class="chat-badge">${unreadCount}</div>` : ''}
          </div>
      </div>`;
  item.onclick = () => openChat(sid, cId, phone); item.oncontextmenu = (e) => { e.preventDefault(); showChatContextMenu(e, sid, cId, phone); }; chatsContainer.appendChild(item);
}
function openChat(sid, cId, phone) {
  activeSessionId = sid; activeChatId = cId;

  // FIX: Use quotes around the data-chat-id value in the selector
  const selector = `.chat-item[data-session-id="${sid}"][data-chat-id="${cId}"]`;
  console.log("Attempting to select:", selector); // Log the selector

  document.querySelectorAll('.chat-item.active').forEach(el => el.classList.remove('active'));
  try {
      document.querySelector(selector)?.classList.add('active');
  } catch (e) {
      console.error("Error applying 'active' class with selector:", selector, e);
      // Fallback or alternative selection method if needed, though quoting should fix it.
  }

  updateChatHeaderDisplay();
  let avatar; const contactInfo = getContactDisplayInfo(phone);
  if (cId.endsWith('@g.us')) avatar = '<i class="fas fa-users"></i>'; else if (contactInfo.name !== contactInfo.phone) avatar = contactInfo.name.substring(0, 1).toUpperCase(); else avatar = '<i class="fas fa-user"></i>';
  if(chatAvatar) chatAvatar.innerHTML = avatar;
  updateChatHeaderMuteStatus(sid, cId); updateMuteActionMenuText();
  const currentLabel = chatLabels[sid]?.[cId] || 'new'; updateChatHeaderLabel(currentLabel);

  // Reset full history loaded status for the message area
  if (chatMessages) chatMessages.dataset.fullHistoryLoaded = "false";

  // Request history only if it's not already loaded or is empty
  if (!allChatData[sid]?.chats[cId] || allChatData[sid].chats[cId].length === 0) {
      requestChatHistory(sid, cId); // Request recent history from DB
      if(chatMessages) chatMessages.innerHTML='<div class="empty-state"><p>טוען היסטוריה...</p></div>';
  } else {
      renderMessages(sid, cId); // Render history already available
  }

  clearUnreadCount(sid, cId); // Clear unread count on opening chat
  // Re-render chat list to update badge immediately
  renderAllChats();
  if (window.innerWidth <= 768) { if(sidebar) sidebar.classList.add('hidden'); if(chatArea) chatArea.classList.add('visible'); }
  if(emptyState) emptyState.style.display='none'; if(muteInterface) muteInterface.classList.remove('visible'); if(emojiPanel) emojiPanel.classList.remove('visible'); if(fileUploadPanel) fileUploadPanel.classList.remove('visible'); if(searchMessageContainer) searchMessageContainer.style.display='none'; clearMessageSearchHighlighting();
}
function updateChatHeaderDisplay() {
  if (!activeChatId || !chatHeaderName || !chatHeaderPhone) return;
  const phone = activeChatId.replace(/@c\.us$/, ''); const contactInfo = getContactDisplayInfo(phone);
  let headerTitle = contactInfo.name; if (contactInfo.name !== contactInfo.phone && contactInfo.field) { headerTitle += ` (${contactInfo.field})`; }
  chatHeaderName.textContent = headerTitle;
  if (chatHeaderPhone) { chatHeaderPhone.textContent = contactInfo.phone; chatHeaderPhone.style.display = 'block'; }
  if(chatSessionIndicator) { chatSessionIndicator.textContent = allChatData[activeSessionId]?.name || activeSessionId; chatSessionIndicator.style.display = 'inline-block'; }
}
function updateChatHeaderLabel(labelKey) { if (!chatHeaderLabel) return; const labelInfo = getLabelInfo(labelKey); chatHeaderLabel.textContent = labelInfo.text; chatHeaderLabel.className = `chat-label-tag ${labelInfo.colorClass}`; chatHeaderLabel.style.display = labelKey && labelKey !== 'new' ? 'inline-block' : 'none'; }
function renderMessages(sid, cId) {
  if (!chatMessages) return;
  const currentScrollTop = chatMessages.scrollTop;
  const isScrolledToBottom = chatMessages.scrollHeight - currentScrollTop <= chatMessages.clientHeight + 50;

  chatMessages.innerHTML = ''; // Clear existing messages
  const msgs = allChatData[sid]?.chats[cId];

  // Add "Load Full History" button/indicator
  const fullHistoryLoaded = chatMessages.dataset.fullHistoryLoaded === "true";
  const historyLoaderDiv = document.createElement('div');
  historyLoaderDiv.id = 'history-loader';
  historyLoaderDiv.style.textAlign = 'center';
  historyLoaderDiv.style.padding = '10px';
  historyLoaderDiv.style.fontSize = '0.9em';
  historyLoaderDiv.style.color = 'var(--text-secondary)';
  historyLoaderDiv.style.cursor = 'pointer';
  historyLoaderDiv.style.display = 'none';

  if (!fullHistoryLoaded) {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'load-full-history-btn';
      loadBtn.innerHTML = '<i class="fas fa-history"></i> טען היסטוריה מלאה';
      // ... (styling for the button) ...
      loadBtn.style.padding = '8px 15px';
      loadBtn.style.border = '1px solid var(--border-color)';
      loadBtn.style.borderRadius = '20px';
      loadBtn.style.backgroundColor = 'var(--bg-secondary)';
      loadBtn.style.color = 'var(--accent-light)';
      loadBtn.style.cursor = 'pointer';
      loadBtn.style.marginBottom = '15px';
      loadBtn.onclick = () => requestFullHistory(sid, cId);
      historyLoaderDiv.appendChild(loadBtn);
      if (msgs?.length > 0 || !fullHistoryLoaded) { // Show button if messages exist or history not fully loaded
          historyLoaderDiv.style.display = 'block';
      }
  }
  chatMessages.appendChild(historyLoaderDiv);

  // Render messages
  if (!msgs?.length) {
      const noMsgDiv = document.createElement('div');
      noMsgDiv.className = 'empty-state';
      noMsgDiv.innerHTML = fullHistoryLoaded ? '<p>אין הודעות להצגה.</p>' : '<p>טוען הודעות אחרונות...</p>';
      if(fullHistoryLoaded) {
          const loader = document.getElementById('history-loader');
          if(loader) loader.style.display = 'none';
      }
      chatMessages.appendChild(noMsgDiv);
      return;
  }

  let currentDate = null;
  const allowedTypes = ['chat', 'ptt', 'image', 'video', 'document', 'audio', 'location', 'vcard', 'error', null]; // Added 'error'

  msgs.forEach(m => {
      // Determine the effective type for rendering logic
      let effectiveType = m.fileType?.toLowerCase();
      if (m.isVoice) effectiveType = 'ptt';
      else if (!effectiveType && m.content) effectiveType = 'chat';

      // Filter out unsupported/system messages
      if (!allowedTypes.includes(effectiveType)) {
           console.warn(`[renderMessages] Skipping message with unhandled type: ${m.type || effectiveType}`, m);
           return;
      }

      if (!m.role) m.role = 'user'; // Default role
      const msgDate = new Date(m.timestamp || Date.now());
      const dateStr = msgDate.toLocaleDateString('he-IL',{day:'2-digit',month:'2-digit',year:'numeric'});
      if (dateStr !== currentDate) {
          currentDate = dateStr;
          const dDiv = document.createElement('div');
          dDiv.className = 'date-divider';
          dDiv.innerHTML = `<span class="date-text">${getDisplayDate(msgDate)}</span>`;
          chatMessages.appendChild(dDiv);
      }
      const mData = { ...m, tempId: m.tempId||null, time: formatTime(msgDate) };

      // --- UPDATED Rendering Logic ---
      if (effectiveType === 'ptt') { // Handle all voice messages (incoming/outgoing)
          renderVoiceMessage(mData, chatMessages);
      } else if (effectiveType && effectiveType !== 'chat' && effectiveType !== 'error' && mData.fileName) { // Handle other file types
          renderFileMessage(mData, chatMessages, effectiveType);
      } else { // Default to text message (includes 'chat', 'error', or unknown)
          renderTextMessage(mData, chatMessages);
      }
      // --- END UPDATED ---
  });

  // Restore scroll position or scroll to bottom
  if (isScrolledToBottom) {
      requestAnimationFrame(() => {
           scrollToBottom();
      });
  } else {
      chatMessages.scrollTop = currentScrollTop;
  }
}

function getDisplayDate(d) { const today=new Date(); const yest=new Date(today); yest.setDate(yest.getDate()-1); if(d.toDateString()===today.toDateString()) return 'היום'; if(d.toDateString()===yest.toDateString()) return 'אתמול'; return d.toLocaleDateString('he-IL',{day:'numeric',month:'long',year:'numeric'}); }
function renderTextMessage(m, cont) { const div=document.createElement('div'); const elId = m.optimistic&&m.tempId ? m.tempId : `msg-${m.id||(m.timestamp+'-'+Math.random().toString(36).substring(2))}`; div.id=elId; div.className = m.role==='assistant'?'message user':'message bot'; div.dataset.timestamp=m.timestamp; let saved=isMessageSaved(activeSessionId,activeChatId,m.content,m.timestamp)?'<i class="fas fa-heart saved-icon"></i>':''; let rHTML=''; if(m.reactions&&Object.keys(m.reactions).length>0){ rHTML='<div class="message-reactions">'; for(const e in m.reactions) rHTML+=`<span>${e}</span>`; rHTML+='</div>'; } div.innerHTML = `<div class="message-content">${linkify(m.content||'')}</div>${rHTML}<div class="message-time">${saved}${m.time}${m.optimistic?'<i class="far fa-clock" style="margin-right:3px;font-size:0.7em;"></i>':''}${m.error?`<i class="fas fa-exclamation-circle" title="${m.errorMessage||'שגיאה'}" style="color:var(--error-color);margin-right:3px;font-size:0.7em;"></i>`:''}</div><div class="message-options"><i class="fas fa-chevron-down"></i></div>`; div.oncontextmenu=(e)=>{e.preventDefault();showMessageContextMenu(e,div,m);}; div.ondblclick=(e)=>{if(e.target.closest('a'))return; e.preventDefault();handleReaction(div,m,'❤️');}; div.querySelector('.message-options')?.addEventListener('click',(e)=>{e.stopPropagation();showMessageContextMenu(e,div,m);}); cont.appendChild(div); }
function renderVoiceMessage(m, cont) {
  const elId = m.optimistic && m.tempId ? m.tempId : `msg-${m.id || (m.timestamp + '-voice-' + Math.random().toString(36).substring(2))}`;
  const div = document.createElement('div');
  div.id = elId;
  div.dataset.timestamp = m.timestamp;
  div.className = m.role === 'assistant' ? 'voice-message user' : 'voice-message bot'; // User = outgoing, Bot = incoming

  if (m.optimistic) div.dataset.uploading = "true";
  if (m.error) div.classList.add('upload-error');

  let rHTML = '';
  if (m.reactions && Object.keys(m.reactions).length > 0) {
      rHTML = '<div class="message-reactions" style="position:absolute; bottom:5px; right:10px; z-index:2; background:transparent!important; padding:0; margin:0;">';
      for (const e in m.reactions) rHTML += `<span style="background:rgba(0,0,0,0.2); padding:1px 4px; border-radius:8px; margin-left:2px;">${e}</span>`;
      rHTML += '</div>';
  }

  let progHTML = '', errHTML = '', sendHTML = '', mainIconHTML = '';
  let contentHTML = '';
  let showAudioInfoContainer = true;

  // Determine content and icon based on state
  if (m.role === 'assistant') { // Outgoing voice message (sent from UI)
      mainIconHTML = '<i class="fas fa-microphone-alt file-icon" style="color:var(--accent-light);"></i>';
      contentHTML = `<span class="file-name">[הקלטה נשלחה] ${m.duration ? `(${m.duration})` : ''}</span>`;
      if (m.optimistic && m.tempId) {
          progHTML = `<div class="upload-progress" id="progress-${elId}" style="margin:4px 0;"><div class="upload-progress-bar"></div></div>`;
          sendHTML = '<i class="far fa-clock" style="margin-right:3px;font-size:0.7em;"></i>';
          contentHTML = `<span class="file-name">[שולח הקלטה...] ${m.duration ? `(${m.duration})` : ''}</span>`; // Show sending status
      } else if (m.error) {
          errHTML = `<i class="fas fa-exclamation-circle" title="${m.errorMessage || 'שגיאה'}" style="color:var(--error-color);margin-right:3px;font-size:0.7em;"></i>`;
          contentHTML = `<span class="file-name">[שגיאה בשליחת הקלטה]</span>`;
      }
  } else { // Incoming voice message (received)
      mainIconHTML = '<i class="fas fa-microphone-alt file-icon" style="color:var(--accent-light);"></i>';
      if (m.isVoiceTranscription && !m.failed && m.content && !m.content.startsWith('[Voice')) {
          // Successfully transcribed
          showAudioInfoContainer = false; // Hide the simple info, show transcription below
          contentHTML = `<div class="message-content" style="padding:8px 10px 0 10px;">
                           <i class="fas fa-microphone" style="margin-left:5px;color:var(--text-secondary);"></i> ${linkify(m.content)}
                         </div>`;
      } else {
          // Not transcribed, failed, or placeholder content
          let placeholderText = `הודעה קולית ${m.duration ? `(${m.duration})` : ''}`;
          if (m.failed) {
              placeholderText += ' (שגיאת תמלול)';
              mainIconHTML = '<i class="fas fa-exclamation-triangle file-icon" style="color:var(--error-color);"></i>'; // Error icon
          } else if (m.content === '[Voice Message]') {
               placeholderText += ' (ממתין לתמלול...)';
               mainIconHTML = '<i class="fas fa-spinner fa-spin file-icon" style="color:var(--text-secondary);"></i>'; // Spinner icon
          } else if (m.content && m.content.startsWith('[Voice -')) { // Handle specific error messages
               placeholderText = m.content; // Show the specific error content
               mainIconHTML = '<i class="fas fa-exclamation-triangle file-icon" style="color:var(--error-color);"></i>';
          }
           contentHTML = `<span class="file-name">${placeholderText}</span>`;
      }
  }

  div.innerHTML = `
      <div class="audio-info-container" style="${showAudioInfoContainer ? 'display:flex;padding:10px;align-items:center;gap:10px;' : 'display:none;'}">
          ${mainIconHTML}
          ${showAudioInfoContainer ? contentHTML : ''}
          ${showAudioInfoContainer && m.duration && m.role === 'user' ? `<span class="voice-duration" style="margin-right:auto;color:var(--text-muted);font-size:0.75rem;">${m.duration}</span>` : ''}
      </div>
      ${!showAudioInfoContainer ? contentHTML : ''} {/* Render transcription content outside if needed */}
      ${rHTML}
      <div class="file-preview-footer" style="padding:5px 8px;${!showAudioInfoContainer ? 'padding-top:0;' : ''}">
          ${progHTML}
          <div class="message-time" data-timestamp="${m.timestamp}">${m.time}${sendHTML}${errHTML}</div>
      </div>
      <div class="message-options"><i class="fas fa-chevron-down"></i></div>`;

  div.oncontextmenu = (e) => { e.preventDefault(); showMessageContextMenu(e, div, m); };
  div.ondblclick = (e) => { e.preventDefault(); handleReaction(div, m, '❤️'); };
  div.querySelector('.message-options')?.addEventListener('click', (e) => { e.stopPropagation(); showMessageContextMenu(e, div, m); });
  if (m.optimistic && m.tempId) addCancelOptionToFilePreview(div, elId);
  cont.appendChild(div);
}

function renderFileMessage(m, cont, effectiveType) {
  if (!m.fileName && !m.optimistic) { // Allow optimistic messages even without filename initially
       console.warn("renderFileMessage called without fileName for non-optimistic message", m);
       renderTextMessage(m, cont); // Fallback to text rendering
       return;
  }
  const actualFileType = effectiveType || m.fileType?.toLowerCase();
  if (!actualFileType || actualFileType === 'error') {
       console.warn(`renderFileMessage called with error type or unknown type: ${actualFileType}`, m);
       renderTextMessage(m, cont); // Fallback to text rendering
       return;
  }

  const contDiv = document.createElement('div');
  const elId = m.optimistic && m.tempId
    ? m.tempId
    : `msg-${m.id || (m.timestamp + '-file-' + Math.random().toString(36).substring(2))}`;

  contDiv.id = elId;
  contDiv.dataset.timestamp = m.timestamp;
  contDiv.className = `file-preview-container ${m.role === 'assistant' ? 'user' : 'bot'}`;

  if (m.optimistic) contDiv.dataset.uploading = "true";
  if (m.error) contDiv.classList.add('upload-error');

  const prevDiv = document.createElement('div');
  prevDiv.className = `file-preview ${m.role === 'assistant' ? 'user' : 'bot'} ${actualFileType || 'document'}`;

  const fileName = m.fileName;
  // We won't use this URL directly for src if it's not optimistic,
  // but we might need it for the download link.
  const url = m.optimistic ? m.localPreviewUrl : `/media/${encodeURIComponent(fileName || 'file')}`; // Simple URL for download link if needed

  prevDiv.dataset.fileUrl = url; // Store the potential download URL

  let contentHTML = '';
  let footerHTML = '';
  let msgContent = m.content || '';

  if (m.fileType && msgContent.startsWith(`[${m.fileType.toUpperCase()}]`)) {
    msgContent = msgContent.substring(`[${m.fileType.toUpperCase()}]`.length).trim();
  }

  let rHTML = '';
  if (m.reactions && Object.keys(m.reactions).length > 0) {
    rHTML = '<div class="message-reactions">';
    for (const e in m.reactions) rHTML += `<span>${e}</span>`;
    rHTML += '</div>';
  }

  let progHTML = '', errHTML = '', sendHTML = '';

  if (m.optimistic && m.tempId) {
    progHTML = `<div class="upload-progress" id="progress-${elId}"><div class="upload-progress-bar"></div></div>`;
    sendHTML = '<i class="far fa-clock" style="margin-right:3px;font-size:0.7em;"></i>';
  } else if (m.error) {
    errHTML = `<i class="fas fa-exclamation-circle" title="${m.errorMessage || 'שגיאה'}" style="color:var(--error-color);margin-right:3px;font-size:0.7em;"></i>`;
  }

  // Only show download link if not optimistic and filename exists
  const downloadLinkHTML = !m.optimistic && fileName
     ? `<a href="/media/${encodeURIComponent(fileName)}" target="_blank" download="${fileName}" title="הורד קובץ" style="margin-right: 10px; color: var(--text-secondary); font-size: 1.1rem;"><i class="fas fa-download"></i></a>`
     : '';
   const docDownloadLinkHTML = !m.optimistic && fileName
      ? `<a href="/media/${encodeURIComponent(fileName)}" target="_blank" download="${fileName}" title="הורד קובץ" style="color: var(--text-secondary); font-size: 1.1rem;"><i class="fas fa-download"></i></a>`
      : '';


  footerHTML = `
    ${msgContent ? `<div class="file-preview-caption">${linkify(msgContent)}</div>` : ''}
    ${rHTML}
    ${progHTML}
    <div class="file-preview-time">${m.time}${sendHTML}${errHTML}</div>
  `;

  // --- MODIFIED SWITCH ---
  switch (actualFileType) {
    case 'image':
      // Show image ONLY if it's optimistic (local preview)
      contentHTML = `<div class="file-preview-content">
                       ${m.optimistic && m.localPreviewUrl ? `<img src="${m.localPreviewUrl}" alt="${fileName || 'Img'}">` : `
                       <div style="padding: 15px; display: flex; align-items: center; gap: 10px;">
                         <i class="fas fa-image file-icon" style="font-size: 2rem; color: var(--text-secondary);"></i>
                         <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fileName || 'תמונה'}</span>
                         ${downloadLinkHTML}
                       </div>`}
                     </div>`;
      break;

    case 'video':
      // Show video ONLY if it's optimistic (local preview)
      contentHTML = `<div class="file-preview-content">
                       ${m.optimistic && m.localPreviewUrl ? `<video src="${m.localPreviewUrl}" controls poster="${m.thumbnailUrl || ''}"></video>` : `
                       <div style="padding: 15px; display: flex; align-items: center; gap: 10px;">
                         <i class="fas fa-video file-icon" style="font-size: 2rem; color: var(--text-secondary);"></i>
                         <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fileName || 'וידאו'}</span>
                         ${downloadLinkHTML}
                       </div>`}
                     </div>`;
      break;

    case 'audio': // Standard audio files (not PTT/voice)
      // Always show player, but src might be local or empty if not optimistic
       const audioSrc = m.optimistic ? m.localPreviewUrl : `/media/${encodeURIComponent(fileName || 'audio.bin')}`;
       contentHTML = `
         <div class="file-preview-content">
           <div class="audio-info-container" style="padding: 10px;">
             <i class="fas fa-music file-icon"></i>
             <span class="file-name" style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fileName || 'שמע'}</span>
             ${downloadLinkHTML}
           </div>
           ${audioSrc ? `<audio controls src="${audioSrc}" style="width: calc(100% - 20px); margin: 0 10px 10px 10px;"></audio>` : '[טעינת שמע נכשלה]'}
         </div>`;
      break;

    default: // Document or other types - Never show preview, only info
      let icon = 'fa-file-alt';
      if (fileName) {
        if (fileName.endsWith('.pdf')) icon = 'fa-file-pdf';
        else if (/\.(docx?)$/i.test(fileName)) icon = 'fa-file-word';
        else if (/\.(xlsx?)$/i.test(fileName)) icon = 'fa-file-excel';
        else if (/\.(pptx?)$/i.test(fileName)) icon = 'fa-file-powerpoint';
        else if (/\.(zip|rar|7z)$/i.test(fileName)) icon = 'fa-file-archive';
      }

      contentHTML = `
        <div class="file-preview-content" style="padding: 15px;">
          <div class="file-info-container" style="display: flex; align-items: center; gap: 10px;">
            <i class="fas ${icon} file-icon" style="font-size: 2rem; color: var(--text-secondary);"></i>
            <div class="file-info" style="flex: 1; overflow: hidden;">
              <div class="file-name" style="font-size: 0.9rem; color: var(--text-primary); word-break: break-all; margin-bottom: 3px;">${fileName || 'מסמך'}</div>
              <div class="file-size" style="font-size: 0.8rem; color: var(--text-secondary);">${formatFileSize(m.fileSize || 0)}</div>
            </div>
            ${docDownloadLinkHTML}
          </div>
        </div>`;
      break;
  }
  // --- END MODIFIED SWITCH ---


  prevDiv.innerHTML = `
    ${contentHTML}
    <div class="file-preview-footer">${footerHTML}</div>
    <div class="message-options"><i class="fas fa-chevron-down"></i></div>
  `;

  contDiv.appendChild(prevDiv);

  if (m.optimistic && m.tempId) {
    addCancelOptionToFilePreview(contDiv, elId);
  }

  contDiv.oncontextmenu = (e) => {
    e.preventDefault();
    showMessageContextMenu(e, contDiv, m);
  };

  contDiv.ondblclick = (e) => {
    e.preventDefault();
    handleReaction(contDiv, m, '❤️');
  };

  contDiv.querySelector('.message-options')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showMessageContextMenu(e, contDiv, m);
  });

  cont.appendChild(contDiv);
}

function showEmptyState() { if(chatHeaderName)chatHeaderName.textContent='בחר צ\'אט'; if(chatHeaderPhone)chatHeaderPhone.style.display='none'; if(chatSessionIndicator)chatSessionIndicator.style.display='none'; if(chatHeaderLabel)chatHeaderLabel.style.display='none'; if(chatStatus)chatStatus.textContent='WhatsApp Bot Manager'; if(chatAvatar)chatAvatar.innerHTML='<i class="fas fa-users"></i>'; if(emptyState)emptyState.style.display='flex'; if(chatMessages)chatMessages.innerHTML=''; activeChatId=null; activeSessionId=null; if(searchMessageContainer)searchMessageContainer.style.display='none'; clearMessageSearchHighlighting(); }
function addMessageReceivedAnimation() { const el = chatMessages?.lastElementChild; if (el?.classList.contains('bot')) { el.classList.add('new-message-highlight'); setTimeout(()=>el.classList.remove('new-message-highlight'), 1500); } }
function scrollToBottom() { setTimeout(() => { if(chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight; }, 50); }

// --- User Actions ---
function handleSearch() { if (!searchInput) return; searchTerm = searchInput.value.trim().toLowerCase(); renderAllChats(); }
function handleChatInput(event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendUserMessage(); } }
function sendUserMessage() { if (!activeChatId || !activeSessionId || !chatInput) { showToast('בחר שיחה.', 'error'); return; } const content = chatInput.innerHTML.trim(); if (!content) return; chatInput.innerHTML = ''; const tempId = `msg-opt-${Date.now()}`; const msg = { role: 'assistant', content, timestamp: Date.now(), optimistic: true, tempId }; if (!allChatData[activeSessionId]?.chats[activeChatId]) { if (!allChatData[activeSessionId]) allChatData[activeSessionId]={chats:{}}; allChatData[activeSessionId].chats[activeChatId]=[]; } allChatData[activeSessionId].chats[activeChatId].push(msg); allChatData[activeSessionId].lastMsgTs=msg.timestamp; renderMessages(activeSessionId, activeChatId); renderAllChats(); const success = sendSocketMessage({ type: 'sendMessage', sessionId: activeSessionId, chatId: activeChatId, message: { content }, tempId }); if (!success) updateOptimisticMessageState(tempId, { error: true, errorMessage: "שגיאת שליחה לשרת" }); }

// --- File Upload (Integrated from Old Version) ---
function handleFileUpload(event) { if (!activeChatId || !activeSessionId) { showToast('בחר שיחה לשליחה.', 'error'); return; } const file = event.target.files[0]; if (!file) return; if (file.size > CONFIG.maxUploadSize) { showToast(`קובץ גדול מדי (מקסימום ${formatFileSize(CONFIG.maxUploadSize)})`, 'error'); event.target.value=''; return; } if(fileUploadPanel) fileUploadPanel.classList.remove('visible'); const tempId = `upld-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; const fType = getFileType(file); const optMsg = { role: 'assistant', timestamp: Date.now(), optimistic: true, tempId, fileType: fType, fileName: file.name, fileSize: file.size, content: '', // Caption handled separately if needed
      time: formatTime(new Date()) }; if (!allChatData[activeSessionId]?.chats[activeChatId]) { if (!allChatData[activeSessionId]) allChatData[activeSessionId]={chats:{}}; allChatData[activeSessionId].chats[activeChatId]=[]; } allChatData[activeSessionId].chats[activeChatId].push(optMsg); allChatData[activeSessionId].lastMsgTs=optMsg.timestamp; const reader = new FileReader(); reader.onload = (e) => { optMsg.localPreviewUrl = e.target.result; renderMessages(activeSessionId, activeChatId); uploadFileToServer(file, fType, tempId); }; reader.onerror = () => { showToast('שגיאה בקריאת קובץ.', 'error'); updateOptimisticMessageState(tempId, { error: true, errorMessage: "FileReader Error" }); }; if (fType === 'document' || fType === 'audio') { // No local preview needed for doc/audio before upload
  renderMessages(activeSessionId, activeChatId); uploadFileToServer(file, fType, tempId); } else { reader.readAsDataURL(file); // Read image/video for preview
} event.target.value=''; }
function getFileType(f) { const t=f.type.toLowerCase(); if(t.startsWith('image/'))return 'image'; if(t.startsWith('video/'))return 'video'; if(t.startsWith('audio/'))return 'audio'; return 'document'; }
function uploadFileToServer(file, fType, tempId) { const token = localStorage.getItem('supabaseToken'); if (!token) { showToast('אימות נדרש.', 'error'); handleLogout(); cancelUpload(tempId); return; } if (!activeChatId || !activeSessionId) { cancelUpload(tempId); return; } const progBar = document.querySelector(`#${tempId} .upload-progress-bar`); const form = new FormData(); const fName = (fType==='audio'&&file instanceof Blob)?'audio':'file'; const upName = file instanceof File ? file.name : `${fType}_${Date.now()}.${(recordedAudioMimeType||'audio/webm').split('/')[1]||'bin'}`; form.append(fName, file, upName); form.append('sessionId', activeSessionId); form.append('chatId', activeChatId); form.append('fileType', fType); form.append('fileName', upName); form.append('tempId', tempId); const optMsg = allChatData[activeSessionId]?.chats[activeChatId]?.find(m=>m.tempId===tempId); if(file instanceof Blob && fType==='audio' && optMsg?.duration) form.append('duration', optMsg.duration); const xhr = new XMLHttpRequest(); const url = (fType==='audio'&&file instanceof Blob)?CONFIG.uploadAudioUrl:CONFIG.uploadUrl; const upInfo = { xhr, file }; if(file instanceof Blob && fType==='audio' && optMsg?.duration) upInfo.duration = optMsg.duration; ongoingUploads.set(tempId, upInfo); xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && progBar) progBar.style.width = Math.min(100, (ev.loaded/ev.total)*100)+'%'; }; xhr.onload = () => { ongoingUploads.delete(tempId); if (xhr.status >= 200 && xhr.status < 300) { /* Success handled by WS message */ } else { console.error(`Upload failed ${tempId}:`, xhr.status, xhr.responseText); showToast(`שגיאת העלאה: ${xhr.statusText||'Server Error'}`, 'error'); updateOptimisticMessageState(tempId, { error: true, errorMessage: `Server Upload Error: ${xhr.status}` }); } }; xhr.onerror = () => { ongoingUploads.delete(tempId); console.error(`Upload network err ${tempId}`); showToast('שגיאת רשת בהעלאה', 'error'); updateOptimisticMessageState(tempId, { error: true, errorMessage: 'Network Error' }); }; xhr.onabort = () => { console.log(`Upload aborted ${tempId}`); ongoingUploads.delete(tempId); }; xhr.open('POST', url, true); xhr.setRequestHeader('Authorization', `Bearer ${token}`); xhr.send(form); }
function cancelUpload(tempId) { const upInfo = ongoingUploads.get(tempId); if (upInfo?.xhr) { upInfo.xhr.abort(); showToast('העלאה בוטלה', 'info'); } let removed = false; let sFound, cFound; Object.keys(allChatData).forEach(sid => { if(removed)return; Object.keys(allChatData[sid].chats||{}).forEach(cid => { if(removed)return; const idx=allChatData[sid].chats[cid]?.findIndex(m=>m.tempId===tempId); if(idx>-1){allChatData[sid].chats[cid].splice(idx,1); removed=true; sFound=sid; cFound=cid;}}); }); document.getElementById(tempId)?.remove(); if(removed){ renderAllChats(); if(activeSessionId===sFound&&activeChatId===cFound)renderMessages(sFound, cFound); } }

// --- Voice Recording (Integrated from Old Version) ---
function startRecording() { if (!activeChatId||!activeSessionId) { showToast('בחר שיחה להקלטה', 'error'); return; } if (isListening) { showToast('סיים הכתבה קולית לפני הקלטה', 'warning'); return; } audioChunks=[]; isRecordingCancelled=false; recordingStartTime=null; if(recordingTimerInterval)clearInterval(recordingTimerInterval); navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{ const opts={mimeType:'audio/webm;codecs=opus'}; if(!MediaRecorder.isTypeSupported(opts.mimeType)){opts.mimeType='audio/ogg;codecs=opus'; if(!MediaRecorder.isTypeSupported(opts.mimeType)){opts.mimeType='audio/webm'; if(!MediaRecorder.isTypeSupported(opts.mimeType))opts.mimeType=''; }} recordedAudioMimeType=opts.mimeType||'audio/webm'; console.log("Using MIME type:", recordedAudioMimeType); mediaRecorder=new MediaRecorder(stream,opts); mediaRecorder.ondataavailable=(ev)=>{if(ev.data.size>0)audioChunks.push(ev.data);}; mediaRecorder.onstop=()=>{ if(isRecordingCancelled){ cleanupRecordingResources(); return; } mediaRecorder?.stream?.getTracks().forEach(t=>t.stop()); if(audioChunks.length===0){showToast('לא הוקלט שמע','warning'); cleanupRecordingResources(); return;} if(!activeChatId||!activeSessionId){showToast('חיבור אבד/שיחה לא נבחרה','error'); cleanupRecordingResources(); return;} const blob=new Blob(audioChunks,{type:recordedAudioMimeType}); const tempId=`upld-${Date.now()}-voice`; const dur=recordingTimer?.textContent||'00:00'; const optMsg={role:'assistant',timestamp:Date.now(),optimistic:true,tempId,isVoice:true,fileType:'audio',content:'[Voice Message]',duration:dur,time:formatTime(new Date())}; if(!allChatData[activeSessionId]?.chats[activeChatId]){if(!allChatData[activeSessionId])allChatData[activeSessionId]={chats:{}}; allChatData[activeSessionId].chats[activeChatId]=[];} allChatData[activeSessionId].chats[activeChatId].push(optMsg); allChatData[activeSessionId].lastMsgTs=optMsg.timestamp; renderMessages(activeSessionId, activeChatId); scrollToBottom(); renderAllChats(); // Update sidebar as well
      uploadFileToServer(blob, 'audio', tempId); cleanupRecordingResources(); }; mediaRecorder.onerror=(ev)=>{console.error('MediaRecorder error:',ev.error); showToast(`שגיאת הקלטה: ${ev.error.name}`,'error'); cancelRecording();}; mediaRecorder.start(); recordingStartTime=Date.now(); if(recordingUI)recordingUI.classList.add('visible'); if(emojiPanel)emojiPanel.classList.remove('visible'); if(fileUploadPanel)fileUploadPanel.classList.remove('visible'); if(voiceBtn)voiceBtn.classList.add('recording'); if(recordingTimer)recordingTimer.textContent='00:00'; startRecordingTimer(); }).catch(err=>{console.error('Mic access error:',err); showToast('שגיאה בגישה למיקרופון: '+err.message,'error'); cancelRecording();}); }
function startRecordingTimer() { if(recordingTimerInterval)clearInterval(recordingTimerInterval); recordingTimerInterval=setInterval(()=>{ if(!recordingStartTime||!recordingTimer){clearInterval(recordingTimerInterval);return;} const sec=Math.floor((Date.now()-recordingStartTime)/1000); const min=Math.floor(sec/60).toString().padStart(2,'0'); const s=(sec%60).toString().padStart(2,'0'); recordingTimer.textContent=`${min}:${s}`;},1000); }
function stopRecording() { if (mediaRecorder?.state==='recording'){isRecordingCancelled=false; try { mediaRecorder.stop(); } catch(e){ console.warn("Error stopping recorder:", e); cleanupRecordingResources(); } } else cancelRecording(); }
function sendRecording() { stopRecording(); }
function cancelRecording() { isRecordingCancelled=true; if(mediaRecorder){if(mediaRecorder.state==='recording'){try{mediaRecorder.onstop=null;mediaRecorder.onerror=null;mediaRecorder.ondataavailable=null;mediaRecorder.stop();}catch(e){console.warn("Stop err on cancel:",e);}} mediaRecorder.stream?.getTracks().forEach(t=>t.stop());} cleanupRecordingResources(); }
function cleanupRecordingResources() { if(recordingTimerInterval)clearInterval(recordingTimerInterval); if(recordingUI)recordingUI.classList.remove('visible'); if(voiceBtn)voiceBtn.classList.remove('recording'); recordingStartTime=null; audioChunks=[]; mediaRecorder=null; }

// --- Mute ---
function showMuteInterface() { if (!activeChatId||!activeSessionId||!muteName||!muteInterface) return; const phone = activeChatId.replace(/@c\.us$/, ''); if (isNumberMuted(phone)) unmuteNumber(phone); else { muteName.textContent=getContactDisplayInfo(phone).name; muteInterface.classList.add('visible'); if(emojiPanel)emojiPanel.classList.remove('visible'); if(fileUploadPanel)fileUploadPanel.classList.remove('visible'); if(recordingUI)recordingUI.classList.remove('visible'); } }
function hideMuteInterface() { if(muteInterface) muteInterface.classList.remove('visible'); }
function muteCurrentChat() { const sid = muteInterface?.dataset.muteSessionId||activeSessionId; const phone = muteInterface?.dataset.mutePhoneNumber||(activeChatId?activeChatId.replace(/@c\.us$/,''):null); delete muteInterface?.dataset.muteSessionId; delete muteInterface?.dataset.mutePhoneNumber; if (!phone||!sid) { showToast("שגיאה: לא ניתן לקבוע שיחה להשתקה.", "error"); hideMuteInterface(); return; } const durInput = document.querySelector('input[name="mute-duration"]:checked'); if (!durInput) { showToast("בחר משך השתקה.", "warning"); return; } const dur = durInput.value; if (sendSocketMessage({ command: 'mute', sessionId: sid, phoneNumber: phone, duration: dur })) showToast('בקשת השתקה נשלחה...', 'info'); hideMuteInterface(); }
function unmuteNumber(phone, sid=activeSessionId) { if (!sid) return; const norm = normalizePhoneNumber(phone); if (sendSocketMessage({ command: 'unmute', sessionId: sid, phoneNumber: norm })) showToast('בקשת ביטול השתקה נשלחה...', 'info'); }
function isNumberMuted(phone) { if (!phone) return false; const norm = normalizePhoneNumber(phone); return blacklistedNumbers.hasOwnProperty(norm); }
function updateChatHeaderMuteStatus(sid, cId) { if (!sid || !cId || !chatStatus || !muteButton) return; if (activeSessionId === sid && activeChatId === cId) { const phone = cId.replace(/@c\.us$/, ''); const muted = isNumberMuted(phone); chatStatus.textContent = muted ? 'מושתק' : 'פעיל'; muteButton.className = `icon-btn fas ${muted ? 'fa-volume-up' : 'fa-volume-mute'}`; muteButton.title = muted ? 'בטל השתקה' : 'השתק שיחה'; } }

// --- History Requests ---
function requestChatHistory(sid, cId) { if (isConnected && sid && cId) sendSocketMessage({ type: 'requestHistory', sessionId: sid, chatId: cId }); }
function requestAllChatsHistory(sid) { if (isConnected && sid) sendSocketMessage({ type: 'requestAllChatsHistory', sessionId: sid }); }
// --- NEW: Request Full History ---
function requestFullHistory(sid, cId) {
  if (!isConnected || !sid || !cId) {
      showToast('לא ניתן לטעון היסטוריה מלאה כעת.', 'error');
      return;
  }
  const loaderDiv = document.getElementById('history-loader');
  if (loaderDiv) {
      loaderDiv.innerHTML = `<i class="fas fa-spinner fa-spin"></i> טוען היסטוריה מלאה...`;
      loaderDiv.style.display = 'block';
      loaderDiv.style.color = 'var(--text-secondary)'; // Reset color
      const btn = loaderDiv.querySelector('.load-full-history-btn');
      if (btn) btn.remove(); // Remove button, show loader
  }
  sendSocketMessage({ type: 'requestFullHistory', sessionId: sid, chatId: cId });
}

// --- Saved Messages & Pinned Chats (Local Storage) ---
function loadSavedData() { try { savedMessages = JSON.parse(localStorage.getItem('savedMessages')||'{}'); } catch(e){savedMessages={};} try { pinnedChats = new Set(JSON.parse(localStorage.getItem('pinnedChats')||'[]')); } catch(e){pinnedChats=new Set();} }
function saveMessage(sid, cId, content, ts) { if (!sid||!cId||!ts) return false; const key=`${sid}-${cId}`; if (!savedMessages[key]) savedMessages[key]=[]; const idx=savedMessages[key].findIndex(m=>m.timestamp===ts); let saved; if(idx===-1){savedMessages[key].push({content,timestamp:ts}); saved=true; showToast('הודעה נשמרה','success');} else {savedMessages[key].splice(idx,1); if(savedMessages[key].length===0) delete savedMessages[key]; saved=false; showToast('שמירה בוטלה','info');} localStorage.setItem('savedMessages',JSON.stringify(savedMessages)); return saved; }
function isMessageSaved(sid, cId, content, ts) { if (!sid||!cId||!ts) return false; const key=`${sid}-${cId}`; return savedMessages[key]?.some(m=>m.timestamp===ts) || false; }
function markMessageAsSaved(el, saved) { const timeEl = el?.querySelector('.message-time, .file-preview-time'); if (!timeEl) return; const icon = timeEl.querySelector('.saved-icon'); if (saved && !icon) { const i = document.createElement('i'); i.className='fas fa-heart saved-icon'; timeEl.insertBefore(i, timeEl.firstChild); } else if (!saved && icon) icon.remove(); }
function togglePinChat(cId) { if (!cId) return; if (pinnedChats.has(cId)) { pinnedChats.delete(cId); showToast('הוסר מנעוצות', 'info'); } else { if (pinnedChats.size >= 5) { showToast('מקסימום 5 שיחות נעוצות', 'warning'); return; } pinnedChats.add(cId); showToast('שיחה נעוצה', 'success'); } localStorage.setItem('pinnedChats', JSON.stringify([...pinnedChats])); renderAllChats(); }

// --- Contact Names & Details ---
function loadContactNames() { try { contactNames = JSON.parse(localStorage.getItem('contactNamesV2') || '{}'); } catch (e) { contactNames = {}; } }
function saveContactNames() { localStorage.setItem('contactNamesV2', JSON.stringify(contactNames)); }
function addContact(sid, phone) { openContactInfoModal(phone, sid); } // Just opens modal
function updateContactNameInUI(norm, contactInfo) { if (!contactNames[norm]) contactNames[norm] = {}; if(contactInfo.name !== undefined) contactNames[norm].name = contactInfo.name; if(contactInfo.field !== undefined) contactNames[norm].field = contactInfo.field; if(contactInfo.notes !== undefined) contactNames[norm].notes = contactInfo.notes; saveContactNames(); if (activeChatId && normalizePhoneNumber(activeChatId.replace(/@c\.us$/, '')) === norm) { updateChatHeaderDisplay(); } renderAllChats(); }

// --- Context Menus ---
function setupContextMenus() { document.getElementById('save-message')?.addEventListener('click', handleSaveMessage); document.getElementById('copy-message')?.addEventListener('click', handleCopyMessage); document.getElementById('react-message')?.addEventListener('click', handleReactMessage); document.getElementById('forward-message')?.addEventListener('click', handleForwardMessage); document.getElementById('delete-message')?.addEventListener('click', handleDeleteMessage); document.getElementById('pin-chat')?.addEventListener('click', handlePinChat); document.getElementById('change-label-chat')?.addEventListener('click', showLabelSubMenu); document.getElementById('add-contact')?.addEventListener('click', handleAddContactFromMenu); document.getElementById('export-chat')?.addEventListener('click', handleExportChat); document.getElementById('mute-chat')?.addEventListener('click', handleMuteChatFromMenu); document.getElementById('delete-chat')?.addEventListener('click', handleDeleteChat); labelSelectionMenu?.querySelectorAll('.menu-item').forEach(item => { item.addEventListener('click', handleChangeLabel); }); }
function showMessageContextMenu(ev, el, data) { closeOtherContextMenus(); const w = messageContextMenu?.offsetWidth||200; const h = messageContextMenu?.offsetHeight||250; let l=ev.pageX; let t=ev.pageY; if(l+w>window.innerWidth)l=window.innerWidth-w-10; if(t+h>window.innerHeight)t=window.innerHeight-h-10; if(l<0)l=10; if(t<0)t=10; if(!messageContextMenu)return; messageContextMenu.style.left=`${l}px`; messageContextMenu.style.top=`${t}px`; messageContextMenu.dataset.sessionId=activeSessionId; messageContextMenu.dataset.chatId=activeChatId; messageContextMenu.dataset.messageId=el.id; messageContextMenu.dataset.content=data.content; messageContextMenu.dataset.timestamp=data.timestamp; messageContextMenu.dataset.venomId=data.id; messageContextMenu.dataset.fileUrl=data.fileUrl; messageContextMenu.dataset.role=data.role; const saveOpt=document.getElementById('save-message'); if(saveOpt){const isSaved=isMessageSaved(activeSessionId,activeChatId,data.content,data.timestamp); saveOpt.innerHTML=`<i class="fas ${isSaved?'fa-heart-broken':'fa-heart'}"></i> <span>${isSaved?'בטל שמירה':'שמור הודעה'}</span>`; saveOpt.querySelector('i').style.color=isSaved?'var(--error-color)':'var(--accent-light)';} const delOpt=document.getElementById('delete-message'); if(delOpt)delOpt.style.display=data.role==='assistant'?'flex':'none'; messageContextMenu.style.display='block'; }
function showChatContextMenu(ev, sid, cId, phone) { closeOtherContextMenus(); const w=chatContextMenu?.offsetWidth||200; const h=chatContextMenu?.offsetHeight||250; let l=ev.pageX; let t=ev.pageY; if(l+w>window.innerWidth)l=window.innerWidth-w-10; if(t+h>window.innerHeight)t=window.innerHeight-h-10; if(l<0)l=10; if(t<0)t=10; if(!chatContextMenu)return; chatContextMenu.style.left=`${l}px`; chatContextMenu.style.top=`${t}px`; chatContextMenu.dataset.sessionId=sid; chatContextMenu.dataset.chatId=cId; chatContextMenu.dataset.phoneNumber=phone; const pinOpt=document.getElementById('pin-chat'); if(pinOpt){const pinned=pinnedChats.has(cId); pinOpt.innerHTML=`<i class="fas fa-thumbtack"></i><span>${pinned?'בטל נעיצה':'נעץ'}</span>`; pinOpt.querySelector('i').style.transform=pinned?'rotate(0deg)':'rotate(-45deg)';} const muteOpt=document.getElementById('mute-chat'); if(muteOpt){const muted=isNumberMuted(phone); muteOpt.innerHTML=`<i class="fas ${muted?'fa-volume-up':'fa-volume-mute'}"></i><span>${muted?'בטל השתקה':'השתק'}</span>`;} chatContextMenu.style.display='block'; }
function showLabelSubMenu(ev) { ev.stopPropagation(); if (!labelSelectionMenu || !chatContextMenu) return; const rect = chatContextMenu.getBoundingClientRect(); const itemRect = ev.currentTarget.getBoundingClientRect(); let subTop = itemRect.top; const subMenuWidth = labelSelectionMenu.offsetWidth || 150; let subLeft = rect.left - subMenuWidth - 5; if (subLeft < 10) { subLeft = rect.right + 5; if (subLeft + subMenuWidth > window.innerWidth - 10) { subLeft = window.innerWidth - subMenuWidth - 10; } } const subMenuHeight = labelSelectionMenu.offsetHeight || 150; if (subTop + subMenuHeight > window.innerHeight - 10) { subTop = window.innerHeight - subMenuHeight - 10; } if (subTop < 10) subTop = 10; labelSelectionMenu.style.left = `${subLeft}px`; labelSelectionMenu.style.top = `${subTop}px`; labelSelectionMenu.style.display = 'block'; chatContextMenu.style.display = 'block'; }
function closeOtherContextMenus(keepMainMenu = false) { document.querySelectorAll('.context-menu').forEach(m => { const shouldKeepChatMenu = keepMainMenu && m.id === 'chat-context-menu'; const shouldKeepLabelMenu = keepMainMenu && m.id === 'label-selection-menu'; if (!shouldKeepChatMenu && !shouldKeepLabelMenu) { m.style.display = 'none'; } }); document.querySelectorAll('.reaction-panel').forEach(p => p.remove()); if (chatActionsMenu?.style.display === 'block') closeChatActionsMenu(); }
function handleSaveMessage() { const sid=messageContextMenu.dataset.sessionId; const cId=messageContextMenu.dataset.chatId; const cont=messageContextMenu.dataset.content; const ts=parseInt(messageContextMenu.dataset.timestamp); const mId=messageContextMenu.dataset.messageId; const el=document.getElementById(mId); if (sid&&cId&&ts&&el) markMessageAsSaved(el, saveMessage(sid,cId,cont,ts)); closeOtherContextMenus(); }
function handleCopyMessage() { const cont=messageContextMenu.dataset.content; if(cont) navigator.clipboard.writeText(cont).then(()=>showToast('הועתק','success')).catch(e=>showToast('שגיאה בהעתקה','error')); closeOtherContextMenus(); }
function handleReactMessage() { const mId=messageContextMenu.dataset.messageId; const el=document.getElementById(mId); if(el){const msgs=allChatData[activeSessionId]?.chats[activeChatId]||[]; const data=msgs.find(m=>m.id===mId||m.tempId===mId); if(data) showReactionPanel(el,data); else console.warn(`React data not found for ${mId}`);} closeOtherContextMenus(); }
function handleForwardMessage() { showToast('Forward not implemented.', 'info'); closeOtherContextMenus(); }
function handleDeleteMessage() { const mId=messageContextMenu.dataset.messageId; const el=document.getElementById(mId); const sid=messageContextMenu.dataset.sessionId; const cId=messageContextMenu.dataset.chatId; const ts=parseInt(messageContextMenu.dataset.timestamp); const vId=!mId.startsWith('upld-')&&!mId.startsWith('msg-opt-')?messageContextMenu.dataset.venomId:null; const role=messageContextMenu.dataset.role; if(role!=='assistant'){showToast('לא ניתן למחוק הודעות נכנסות','warning'); closeOtherContextMenus(); return;} if(el&&sid&&cId){if(confirm('למחוק הודעה זו?')){el.remove(); let removed=false; if(allChatData[sid]?.chats[cId]){const len=allChatData[sid].chats[cId].length; allChatData[sid].chats[cId]=allChatData[sid].chats[cId].filter(m=>!((vId&&m.id===vId)||m.timestamp===ts||m.tempId===mId)); removed=allChatData[sid].chats[cId].length<len; if(removed)renderAllChats();} if(vId){sendSocketMessage({type:'deleteMessage',sessionId:sid,chatId:cId,venomMessageId:vId}); showToast('בקשת מחיקה נשלחה','info');} else {if(mId.startsWith('upld-'))cancelUpload(mId); showToast('הודעה נמחקה מקומית','info');}}} closeOtherContextMenus(); }
function handlePinChat() { const cId = chatContextMenu?.dataset.chatId; if(cId) togglePinChat(cId); closeOtherContextMenus(); }
function handleAddContactFromMenu() { const phone = chatContextMenu?.dataset.phoneNumber; if (phone) openContactInfoModal(phone); closeOtherContextMenus(); }
function handleExportChat() { showToast('Export not implemented.', 'info'); closeOtherContextMenus(); }
function handleMuteChatFromMenu() { const phone = chatContextMenu?.dataset.phoneNumber; const sid = chatContextMenu?.dataset.sessionId; if (!phone||!sid) return; const muted = isNumberMuted(phone); if (muted) unmuteNumber(phone, sid); else { if(muteName)muteName.textContent=getContactDisplayInfo(phone).name; if(muteInterface){muteInterface.classList.add('visible'); muteInterface.dataset.muteSessionId=sid; muteInterface.dataset.mutePhoneNumber=phone;} if(emojiPanel)emojiPanel.classList.remove('visible'); if(fileUploadPanel)fileUploadPanel.classList.remove('visible'); if(recordingUI)recordingUI.classList.remove('visible'); } closeOtherContextMenus(); }
function handleDeleteChat() { const sid=chatContextMenu?.dataset.sessionId; const cId=chatContextMenu?.dataset.chatId; const phone=chatContextMenu?.dataset.phoneNumber; if(sid&&cId){const sName=allChatData[sid]?.name||sid; if(confirm(`למחוק שיחה עם ${getContactDisplayInfo(phone).name} מסשן ${sName} (מהממשק בלבד)?`)){if(allChatData[sid]?.chats[cId]){delete allChatData[sid].chats[cId]; let maxTs=0; if(allChatData[sid].chats)Object.values(allChatData[sid].chats).forEach(msgs=>{if(!Array.isArray(msgs))return; const ts=getLastMessageTimestamp(msgs); if(ts>maxTs)maxTs=ts;}); allChatData[sid].lastMsgTs=maxTs; if(activeSessionId===sid&&activeChatId===cId)showEmptyState(); renderAllChats(); showToast('שיחה נמחקה מהממשק','success');}}} closeOtherContextMenus(); }
function handleChangeLabel(ev) { const sid = chatContextMenu?.dataset.sessionId || activeSessionId; const cId = chatContextMenu?.dataset.chatId || activeChatId; const newLabel = ev.currentTarget.dataset.label; if (!sid || !cId || !newLabel) { console.error("Missing data for label change:", sid, cId, newLabel); showToast("שגיאה בשינוי התגית.", "error"); closeOtherContextMenus(); return; } if (!chatLabels[sid]) chatLabels[sid] = {}; chatLabels[sid][cId] = newLabel; renderAllChats(); if (activeSessionId === sid && activeChatId === cId) { updateChatHeaderLabel(newLabel); if (contactInfoModal?.style.display === 'flex' && contactInfoLabelSelect) { contactInfoLabelSelect.value = newLabel; } } sendSocketMessage({ type: 'changeLabel', sessionId: sid, chatId: cId, label: newLabel }); showToast(`מעדכן תגית ל: ${getLabelInfo(newLabel).text}...`, 'info'); closeOtherContextMenus(); }

// --- Message Reactions ---
function showReactionPanel(el, data) { el.querySelector('.reaction-panel')?.remove(); const panel=document.createElement('div'); panel.className='reaction-panel'; panel.style.position='absolute'; panel.style.bottom='calc(100% + 5px)'; panel.style.zIndex='10'; if(data.role==='assistant') panel.style.right='10px'; else panel.style.left='10px'; const reactions=['👍','❤️','😂','😮','😢','🙏']; reactions.forEach(e=>{const div=document.createElement('div'); div.textContent=e; div.onclick=(ev)=>{ev.stopPropagation(); handleReaction(el,data,e); panel.remove();}; panel.appendChild(div);}); if(!el.style.position||el.style.position==='static')el.style.position='relative'; el.appendChild(panel); setTimeout(()=>{document.addEventListener('click',function closeP(ev){if(panel&&!panel.contains(ev.target))panel.remove(); document.removeEventListener('click',closeP,{capture:true,once:true});},{capture:true,once:true});},10); }
function handleReaction(el, data, emoji) { const sid=activeSessionId; const cId=activeChatId; const ts=data.timestamp; const mId=data.id||data.tempId; const vId=!data.optimistic&&data.id?data.id:null; if (!sid||!cId||!mId) return; if (!data.reactions) data.reactions={}; let reacted=false; if(data.reactions[emoji]){delete data.reactions[emoji];} else {data.reactions[emoji]=true; reacted=true;} updateReactionsOnMessage(el, data.reactions); if(vId) sendSocketMessage({type:'reactMessage',sessionId:sid,chatId:cId,venomMessageId:vId,reaction:reacted?emoji:null}); }
function updateReactionsOnMessage(el, reactions) { let cont = el?.querySelector('.message-reactions'); const anchor = el?.querySelector('.message-time, .file-preview-footer'); if (reactions && Object.keys(reactions).length>0) { if (!cont && anchor) { cont=document.createElement('div'); cont.className='message-reactions'; anchor.parentNode.insertBefore(cont, anchor); } else if (!cont && el) { cont=el.appendChild(document.createElement('div')); cont.className='message-reactions'; } if(cont){ cont.innerHTML=''; for(const e in reactions) cont.innerHTML+=`<span>${e}</span>`; cont.style.justifyContent = el.classList.contains('user')?'flex-end':'flex-start'; } } else if (cont) cont.remove(); }

// --- Message Search ---
function setupMessageSearch() { searchChatBtn?.addEventListener('click',()=>{if(activeChatId){searchMessageContainer.style.display='block'; searchMessageInput.value=''; clearMessageSearchHighlighting(); messageSearchResults=[]; currentSearchResultIndex=-1; updateSearchResultCount(); searchMessageInput.focus();}else{showToast('בחר שיחה לחיפוש.','info');}}); closeSearchMsgBtn?.addEventListener('click',()=>{searchMessageContainer.style.display='none'; searchMessageInput.value=''; clearMessageSearchHighlighting(); messageSearchResults=[]; currentSearchResultIndex=-1; updateSearchResultCount();}); searchMessageInput?.addEventListener('input',(e)=>{messageSearchTerm=e.target.value.toLowerCase().trim(); if(messageSearchTerm.length>1)findMessagesInChat(messageSearchTerm); else{clearMessageSearchHighlighting(); messageSearchResults=[]; currentSearchResultIndex=-1; updateSearchResultCount();}}); searchMessageInput?.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault(); navigateToSearchResult(e.shiftKey?-1:1);}else if(e.key==='Escape')closeSearchMsgBtn.click();}); searchPrevBtn?.addEventListener('click',()=>navigateToSearchResult(-1)); searchNextBtn?.addEventListener('click',()=>navigateToSearchResult(1)); }
function findMessagesInChat(term) { clearMessageSearchHighlighting(); messageSearchResults=[]; currentSearchResultIndex=-1; if(!term||!activeChatId||!activeSessionId||!chatMessages) return; chatMessages.querySelectorAll('.message, .voice-message, .file-preview-container').forEach(el=>{ if(el.dataset.uploading==='true') return; const cEl=el.querySelector('.message-content'); const capEl=el.querySelector('.file-preview-caption'); const fnEl=el.querySelector('.file-name'); let txt= (cEl?.textContent||'')+' '+(capEl?.textContent||'')+' '+(fnEl?.textContent||''); if(txt.toLowerCase().includes(term)){el.classList.add('highlight-search'); messageSearchResults.push(el);} }); if (messageSearchResults.length>0){currentSearchResultIndex=0; scrollToElement(messageSearchResults[0]);} updateSearchResultCount(); }
function navigateToSearchResult(dir) { if(messageSearchResults.length===0)return; if(currentSearchResultIndex>=0&&messageSearchResults[currentSearchResultIndex])messageSearchResults[currentSearchResultIndex].style.outline=''; currentSearchResultIndex+=dir; if(currentSearchResultIndex<0)currentSearchResultIndex=messageSearchResults.length-1; else if(currentSearchResultIndex>=messageSearchResults.length)currentSearchResultIndex=0; const el=messageSearchResults[currentSearchResultIndex]; if(!el) return; scrollToElement(el); updateSearchResultCount(); el.style.outline='2px solid var(--accent-light)'; el.style.outlineOffset='2px'; setTimeout(()=>{if(el)el.style.outline='';},1000); }
function updateSearchResultCount() { if(!searchResultCount||!searchPrevBtn||!searchNextBtn) return; if(messageSearchResults.length>0){ searchResultCount.textContent=`${currentSearchResultIndex+1}/${messageSearchResults.length}`; searchPrevBtn.style.color='var(--text-secondary)'; searchNextBtn.style.color='var(--text-secondary)'; }else{ searchResultCount.textContent=messageSearchTerm?'0/0':''; searchPrevBtn.style.color='var(--text-muted)'; searchNextBtn.style.color='var(--text-muted)'; } }
function clearMessageSearchHighlighting() { chatMessages?.querySelectorAll('.highlight-search').forEach(el=>{el.classList.remove('highlight-search'); el.style.outline='';}); }
function scrollToElement(el) { if(el&&chatMessages){const r=el.getBoundingClientRect(); const pR=chatMessages.getBoundingClientRect(); if(r.top<pR.top||r.bottom>pR.bottom)el.scrollIntoView({behavior:'smooth',block:'center'});} }

// --- Speech Recognition ---
function initSpeechRecognition() { window.SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition; if(!window.SpeechRecognition){if(voiceBtn){voiceBtn.setAttribute('title','הכתבה לא נתמכת');voiceBtn.removeEventListener('dblclick',toggleSpeechRecognition);}return;} try{ recognition=new SpeechRecognition(); recognition.continuous=true; recognition.interimResults=true; recognition.lang='he-IL'; recognition.onresult=(ev)=>{let iT='',fT='';for(let i=ev.resultIndex;i<ev.results.length;++i){if(ev.results[i].isFinal)fT+=ev.results[i][0].transcript;else iT+=ev.results[i][0].transcript;} if(fT&&chatInput){chatInput.textContent+=fT+' '; placeCaretAtEnd(chatInput);}}; recognition.onerror=(ev)=>{console.error('Speech error:',ev.error);showToast(`שגיאת זיהוי דיבור: ${ev.error}`,'error');if(isListening){toggleSpeechRecognition();if(voiceBtn)voiceBtn.classList.remove('recording');}}; recognition.onend=()=>{isListening=false;if(voiceBtn)voiceBtn.classList.remove('recording');};}catch(e){console.error("Speech init failed:",e);if(voiceBtn){voiceBtn.setAttribute('title','שגיאה בהפעלת הכתבה');voiceBtn.removeEventListener('dblclick',toggleSpeechRecognition);}} }
function toggleSpeechRecognition() { if(!recognition)return; if(mediaRecorder?.state==='recording'){showToast('סיים הקלטה לפני הכתבה','warning'); return;} if(isListening){recognition.stop();showToast('הכתבה הופסקה','info');}else{try{recognition.start();isListening=true;if(voiceBtn)voiceBtn.classList.add('recording');showToast('הכתבה פעילה...','success');}catch(err){console.error('Speech start err:',err);showToast(err.name==='not-allowed'?'נדרשת הרשאה למיקרופון.':'שגיאה בהפעלת הכתבה.','error');isListening=false;if(voiceBtn)voiceBtn.classList.remove('recording');}} }

// --- Theme Toggle ---
function initThemeToggle() { const btn = document.createElement('i'); btn.className='fas fa-adjust icon-btn theme-toggle-btn'; btn.style.cursor='pointer'; btn.title='שנה ערכת נושא'; btn.onclick=toggleDarkMode; const cont = document.querySelector('.chat-actions'); const ref = document.getElementById('chat-options-btn'); if(cont){if(ref)cont.insertBefore(btn,ref.nextSibling); else cont.appendChild(btn);} const dark=window.matchMedia?.('(prefers-color-scheme: dark)').matches; const theme=localStorage.getItem('dark-mode'); if(theme==='true'||(theme===null&&dark)){document.body.classList.add('dark-mode'); updateThemeIcon(true);}else{document.body.classList.remove('dark-mode'); updateThemeIcon(false);} }
function toggleDarkMode() { const isDark = document.body.classList.toggle('dark-mode'); localStorage.setItem('dark-mode', isDark); updateThemeIcon(isDark); }
function updateThemeIcon(isDark) { const btn=document.querySelector('.theme-toggle-btn'); if(btn) btn.className=`fas ${isDark?'fa-sun':'fa-moon'} icon-btn theme-toggle-btn`; }

// --- AI Toggle ---
function loadAiState() { const s=localStorage.getItem('aiEnabled'); isAiEnabled = s===null?true:(s==='true'); updateAiToggleVisuals(); }
function toggleAiState() { isAiEnabled=!isAiEnabled; localStorage.setItem('aiEnabled',isAiEnabled); updateAiToggleVisuals(); showToast(`AI ${isAiEnabled?'הופעל':'כובה'}`,'info'); sendSocketMessage({type:'setAiState',enabled:isAiEnabled}); }
function updateAiToggleVisuals() { if(!aiToggleBtn)return; aiToggleBtn.classList.toggle('ai-enabled',isAiEnabled); aiToggleBtn.classList.toggle('ai-disabled',!isAiEnabled); aiToggleBtn.title=isAiEnabled?'כבה AI':'הדלק AI'; }

// --- Notifications ---
function initializeNotifications() { try { notificationSound = new Audio('audio/notification.mp3'); notificationSound.load(); const enable=()=>{if(notificationSound?.paused)notificationSound.play().then(()=>notificationSound.pause()).catch(e=>{}); document.body.removeEventListener('click',enable,{once:true}); document.body.removeEventListener('keydown',enable,{once:true});}; document.body.addEventListener('click',enable,{once:true}); document.body.addEventListener('keydown',enable,{once:true}); } catch(e){notificationSound=null;} }
function playNotificationSound() { if(notificationSound?.readyState>=3) { notificationSound.currentTime=0; notificationSound.play().catch(e=>{}); } }
function updateUnreadCount(sid, cId) { if(!sid||!cId)return; if(!unreadMessages[sid])unreadMessages[sid]={}; if(!unreadMessages[sid][cId])unreadMessages[sid][cId]=0; unreadMessages[sid][cId]++; // Rerender to update the badge visually
  renderAllChats(); }
function clearUnreadCount(sid, cId) { if(unreadMessages[sid]?.[cId]){unreadMessages[sid][cId]=0; // No need to update badge here, renderAllChats will do it
  } }

// --- Chat Actions Menu ---
function setupChatActionsMenu() { if(!chatActionsButton||!chatActionsMenu)return; const contactInfoAct=document.getElementById('open-contact-info-action'); // Use new ID
  const selectMsgsAct=document.getElementById('select-messages-action'); const clearChatAct=document.getElementById('clear-chat-action'); const deleteChatAct=document.getElementById('delete-chat-action-from-menu'); const searchAct=document.getElementById('search-action-from-menu'); const muteAct=document.getElementById('mute-action-from-menu'); const themeAct=document.getElementById('theme-action-from-menu'); const logoutAct=document.getElementById('logout-action-from-menu'); chatActionsButton.onclick=(ev)=>{ ev.stopPropagation(); if(!activeChatId||!activeSessionId){showToast("בחר שיחה.", "info"); return;} closeOtherContextMenus(); if(chatActionsMenu.style.display==='block'){closeChatActionsMenu(); return;} updateMuteActionMenuText(); const themeIcon=themeAct?.querySelector('i'); if(themeIcon)themeIcon.className=`fas ${document.body.classList.contains('dark-mode')?'fa-sun':'fa-moon'}`; const rect=chatActionsButton.getBoundingClientRect(); chatActionsMenu.style.left=`${rect.left-(chatActionsMenu.offsetWidth||200)+rect.width}px`; chatActionsMenu.style.top=`${rect.bottom+5}px`; const menuRect=chatActionsMenu.getBoundingClientRect(); if(chatActionsMenu.offsetLeft<10)chatActionsMenu.style.left='10px'; if(chatActionsMenu.offsetTop+menuRect.height>window.innerHeight-10)chatActionsMenu.style.top=`${window.innerHeight-menuRect.height-10}px`; chatActionsMenu.style.display='block'; setTimeout(()=>document.addEventListener('click',closeChatActionsMenuOnClickOutside,{once:true,capture:true}),0); }; contactInfoAct?.addEventListener('click',()=> { if(activeChatId) openContactInfoModal(activeChatId.replace(/@c\.us$/,'')); closeChatActionsMenu(); }); selectMsgsAct?.addEventListener('click',()=>showToast('Select Msgs NYI','info')&closeChatActionsMenu()); clearChatAct?.addEventListener('click',()=>{if(!activeChatId||!activeSessionId)return; if(confirm(`לנקות שיחה זו מהממשק?`)){if(allChatData[activeSessionId]?.chats[activeChatId]){allChatData[activeSessionId].chats[activeChatId]=[]; renderMessages(activeSessionId,activeChatId); renderAllChats(); showToast('השיחה נוקתה מהממשק','success');}} closeChatActionsMenu();}); deleteChatAct?.addEventListener('click',()=>handleDeleteChatFromActive()&closeChatActionsMenu()); searchAct?.addEventListener('click',()=>searchChatBtn?.click()&closeChatActionsMenu()); muteAct?.addEventListener('click',()=>muteButton?.click()&closeChatActionsMenu()); themeAct?.addEventListener('click',()=>toggleDarkMode()&closeChatActionsMenu()); logoutAct?.addEventListener('click',()=>handleLogout()&closeChatActionsMenu()); }
function handleDeleteChatFromActive() { const sid=activeSessionId; const cId=activeChatId; if(!sid||!cId)return; const phone=cId.replace(/@c\.us$/,''); const sName=allChatData[sid]?.name||sid; const contactInfo = getContactDisplayInfo(phone); if(confirm(`למחוק שיחה עם ${contactInfo.name} מסשן ${sName} (מהממשק בלבד)?`)){if(allChatData[sid]?.chats[cId]){delete allChatData[sid].chats[cId]; let maxTs=0; if(allChatData[sid].chats)Object.values(allChatData[sid].chats).forEach(msgs=>{if(!Array.isArray(msgs))return; const ts=getLastMessageTimestamp(msgs); if(ts>maxTs)maxTs=ts;}); allChatData[sid].lastMsgTs=maxTs; showEmptyState(); renderAllChats(); showToast('שיחה נמחקה מהממשק','success');}}}
function closeChatActionsMenuOnClickOutside(ev) { if(chatActionsMenu?.style.display==='block'&&!chatActionsMenu.contains(ev.target)&&ev.target!==chatActionsButton&&!chatActionsButton?.contains(ev.target)) closeChatActionsMenu(); }
function closeChatActionsMenu() { if(chatActionsMenu){chatActionsMenu.style.display='none'; document.removeEventListener('click',closeChatActionsMenuOnClickOutside,{capture:true});} }
function updateMuteActionMenuText() { const muteAct=document.getElementById('mute-action-from-menu'); if(!muteAct||!activeChatId)return; const phone=activeChatId.replace(/@c\.us$/,''); const muted=isNumberMuted(phone); muteAct.innerHTML=`<i class="fas ${muted?'fa-volume-up':'fa-volume-mute'}"></i><span>${muted?'בטל השתקה':'השתק'}</span>`; }

// --- Settings Modal ---
function setupSettingsModal() { if (!settingsModal||!settingsBtn||!settingsModalCloseBtn||!cancelSettingsBtn||!saveSettingsBtn) return; settingsBtn.onclick = openSettingsModal; settingsModalCloseBtn.onclick = closeSettingsModal; cancelSettingsBtn.onclick = closeSettingsModal; settingsModal.onclick = (ev) => { if (ev.target === settingsModal) closeSettingsModal(); }; saveSettingsBtn.onclick = saveAISettings; }
async function openSettingsModal() { console.log("Opening settings modal..."); if (!settingsModal || !supabase) { console.error("Settings modal or supabase client not available."); return; } try { console.log("Fetching user for settings..."); const { data: { user }, error: userErr } = await supabase.auth.getUser(); if (userErr || !user) { console.error("User not found or error fetching user:", userErr); throw userErr || new Error("User not logged in"); } console.log(`Fetching settings from DB for user: ${user.id}`); const { data, error } = await supabase.from('user_setting').select('*').eq('user_profile_id', user.id).maybeSingle(); if (error && error.code !== 'PGRST116') { console.error("Error fetching settings from DB:", error); throw error; } console.log("Settings fetched from DB (or null):", data); aiInstructionsInput.value = data?.ai_instructions || DEFAULT_AI_SETTINGS.ai_instructions; aiModelSelect.value = data?.ai_model || DEFAULT_AI_SETTINGS.ai_model; aiTemperatureInput.value = data?.ai_temperature ?? DEFAULT_AI_SETTINGS.ai_temperature; aiMaxTokensInput.value = data?.ai_max_tokens || DEFAULT_AI_SETTINGS.ai_max_tokens; aiDelayInput.value = data?.ai_delay_seconds ?? DEFAULT_AI_SETTINGS.ai_delay_seconds; console.log("Populated settings modal fields."); } catch (err) { console.error('Error during openSettingsModal:', err.message); showToast('שגיאה בטעינת הגדרות עדכניות מהשרת.', 'error'); aiInstructionsInput.value = DEFAULT_AI_SETTINGS.ai_instructions; aiModelSelect.value = DEFAULT_AI_SETTINGS.ai_model; aiTemperatureInput.value = DEFAULT_AI_SETTINGS.ai_temperature; aiMaxTokensInput.value = DEFAULT_AI_SETTINGS.ai_max_tokens; aiDelayInput.value = DEFAULT_AI_SETTINGS.ai_delay_seconds; console.log("Populated settings modal fields with defaults due to error."); } settingsModal.style.display = 'flex'; }
function closeSettingsModal() { if (settingsModal) settingsModal.style.display = 'none'; }
function saveAISettings() { if (!supabase || !saveSettingsBtn || !aiInstructionsInput || !aiModelSelect || !aiTemperatureInput || !aiMaxTokensInput || !aiDelayInput) { console.error("One or more settings elements or supabase client is missing."); return; } saveSettingsBtn.disabled = true; showLoading(saveSettingsBtn); const settings = { ai_instructions: aiInstructionsInput.value.trim(), ai_model: aiModelSelect.value, ai_temperature: parseFloat(aiTemperatureInput.value), ai_max_tokens: parseInt(aiMaxTokensInput.value), ai_delay_seconds: parseInt(aiDelayInput.value) }; console.log("[Save Settings] Data collected from inputs:", settings); if (isNaN(settings.ai_temperature) || settings.ai_temperature < 0 || settings.ai_temperature > 1) { showToast('טמפרטורה לא חוקית (0-1)', 'error'); hideLoading(saveSettingsBtn); saveSettingsBtn.disabled = false; return; } if (isNaN(settings.ai_max_tokens) || settings.ai_max_tokens < 50) { showToast('מקסימום טוקנים נמוך מדי (מינימום 50)', 'error'); hideLoading(saveSettingsBtn); saveSettingsBtn.disabled = false; return; } if (isNaN(settings.ai_delay_seconds) || settings.ai_delay_seconds < 0) { showToast('השהיה לא יכולה להיות שלילית', 'error'); hideLoading(saveSettingsBtn); saveSettingsBtn.disabled = false; return; } console.log("[Save Settings] Sending updateAiSettings message via WebSocket..."); if (sendSocketMessage({ type: 'updateAiSettings', settings })) { showToast('שומר הגדרות...', 'info'); } else { showToast('שגיאה בשליחת הבקשה לשרת.', 'error'); hideLoading(saveSettingsBtn); saveSettingsBtn.disabled = false; } setTimeout(() => { if (saveSettingsBtn && saveSettingsBtn.disabled) { hideLoading(saveSettingsBtn); saveSettingsBtn.disabled = false; console.log("[Save Settings] Re-enabled save button after timeout."); } }, 5000); }
function loadAiSettingsFromInit(settings) { if (!settings) { console.log("loadAiSettingsFromInit received null/undefined settings."); return; } console.log("loadAiSettingsFromInit received settings:", settings); DEFAULT_AI_SETTINGS.ai_instructions = settings.ai_instructions || ''; DEFAULT_AI_SETTINGS.ai_model = settings.ai_model || 'gpt-4o-mini'; DEFAULT_AI_SETTINGS.ai_temperature = settings.ai_temperature ?? 0.4; DEFAULT_AI_SETTINGS.ai_max_tokens = settings.ai_max_tokens || 300; DEFAULT_AI_SETTINGS.ai_delay_seconds = settings.ai_delay_seconds ?? 5; if (settingsModal && settingsModal.style.display === 'flex') { console.log("Settings modal is open, refreshing its content with confirmed data from server and closing."); aiInstructionsInput.value = settings.ai_instructions || ''; aiModelSelect.value = settings.ai_model || DEFAULT_AI_SETTINGS.ai_model; aiTemperatureInput.value = settings.ai_temperature ?? DEFAULT_AI_SETTINGS.ai_temperature; aiMaxTokensInput.value = settings.ai_max_tokens || DEFAULT_AI_SETTINGS.ai_max_tokens; aiDelayInput.value = settings.ai_delay_seconds ?? DEFAULT_AI_SETTINGS.ai_delay_seconds; if (saveSettingsBtn && saveSettingsBtn.disabled) { hideLoading(saveSettingsBtn); saveSettingsBtn.disabled = false; } closeSettingsModal(); } else { console.log("AI settings state updated from server. Modal is closed."); } }

// --- QR Code Modal ---
function setupQrModal() { qrModalCloseBtn?.addEventListener('click', hideQrModal); qrModal?.addEventListener('click', (ev) => { if (ev.target === qrModal) hideQrModal(); }); }
function showQrModal(sid, qrBase64) { if (!qrModal||!qrCodeImg||!qrSessionNameSpan||!qrLoadingDiv) return; qrSessionNameSpan.textContent = allChatData[sid]?.name || sid; if (qrBase64) { qrCodeImg.src = qrBase64; qrCodeImg.style.display = 'block'; qrLoadingDiv.style.display = 'none'; } else { qrCodeImg.src = ''; qrCodeImg.style.display = 'none'; qrLoadingDiv.style.display = 'block'; } qrModal.style.display = 'flex'; qrModal.dataset.sessionId = sid; }
function hideQrModal() { if (qrModal) { qrModal.style.display = 'none'; if(qrCodeImg) qrCodeImg.src = ''; qrModal.removeAttribute('data-session-id'); } }

// --- Mobile Responsiveness ---
function showSidebar() { if(sidebar)sidebar.classList.remove('hidden'); if(chatArea)chatArea.classList.remove('visible'); activeChatId=null; activeSessionId=null; }

// --- Contact Info Modal ---
function setupContactInfoModal() { if (!contactInfoModal || !contactInfoModalCloseBtn || !saveContactInfoBtn) { console.warn("Contact info modal elements not found. Skipping setup."); return; } contactInfoModalCloseBtn.onclick = closeContactInfoModal; saveContactInfoBtn.onclick = saveContactInfo; contactInfoModal.onclick = (ev) => { if (ev.target === contactInfoModal) closeContactInfoModal(); }; contactInfoLabelSelect?.addEventListener('change', handleLabelChangeFromModal); }
function openContactInfoModal(phone) { if (!contactInfoModal || !activeChatId || !activeSessionId) return; const normPhone = normalizePhoneNumber(phone); const contact = contactNames[normPhone] || {}; const currentLabel = chatLabels[activeSessionId]?.[activeChatId] || 'new'; console.log(`Opening contact info for ${normPhone}`, contact); if(contactInfoNameInput) contactInfoNameInput.value = contact.name || ''; if(contactInfoFieldInput) contactInfoFieldInput.value = contact.field || ''; if(contactInfoPhoneSpan) contactInfoPhoneSpan.textContent = formatPhoneNumber(normPhone); if(contactInfoNotesTextarea) contactInfoNotesTextarea.value = contact.notes || ''; if (contactInfoLabelSelect) { contactInfoLabelSelect.innerHTML = ''; ['new', 'inprogress', 'paid', 'waiting', 'notinterested'].forEach(labelKey => { const option = document.createElement('option'); option.value = labelKey; option.textContent = getLabelInfo(labelKey).text; contactInfoLabelSelect.appendChild(option); }); contactInfoLabelSelect.value = currentLabel; } contactInfoModal.dataset.phone = normPhone; if(contactInfoScheduledCallDiv) { contactInfoScheduledCallDiv.textContent = "טוען מידע על שיחות קבועות..."; sendSocketMessage({ type: 'getScheduledCall', sessionId: activeSessionId, chatId: activeChatId }); } contactInfoModal.style.display = 'flex'; }
function closeContactInfoModal() { if (contactInfoModal) { contactInfoModal.style.display = 'none'; contactInfoModal.removeAttribute('data-phone'); } }
function saveContactInfo(){if(!saveContactInfoBtn||!contactInfoModal)return;const phone=contactInfoModal.dataset.phone;if(!phone||!activeSessionId){showToast("שגיאה: לא ניתן לשמור פרטים ללא מספר טלפון או סשן פעיל.","error");return;}const detailsToUpdate={};const currentContact=contactNames[phone]||{};const newName=contactInfoNameInput?.value.trim();const newField=contactInfoFieldInput?.value.trim();const newNotes=contactInfoNotesTextarea?.value.trim();let changed=false;if(newName!==undefined&&newName!==(currentContact.name||'')){detailsToUpdate.contact_name=newName;changed=true;}if(newField!==undefined&&newField!==(currentContact.field||'')){detailsToUpdate.business_field=newField;changed=true;}if(newNotes!==undefined&&newNotes!==(currentContact.notes||'')){detailsToUpdate.notes=newNotes;changed=true;}if(changed){console.log("Sending contact update for:",phone," Changes:",detailsToUpdate);const success=sendSocketMessage({type:'updateContact',phoneNumber:phone,sessionId:activeSessionId,contactDetails:detailsToUpdate});if(success){showToast("מעדכן פרטי איש קשר...","info");if(!contactNames[phone])contactNames[phone]={};if(detailsToUpdate.contact_name!==undefined)contactNames[phone].name=detailsToUpdate.contact_name;if(detailsToUpdate.business_field!==undefined)contactNames[phone].field=detailsToUpdate.business_field;if(detailsToUpdate.notes!==undefined)contactNames[phone].notes=detailsToUpdate.notes;saveContactNames();renderAllChats();updateChatHeaderDisplay();}else{showToast("שגיאה בשליחת העדכון לשרת.","error");}}else{console.log("No changes detected in contact info fields (Name, Field, Notes).");showToast("לא זוהו שינויים לשמירה.","info");}closeContactInfoModal();}function handleLabelChangeFromModal(event) { if (!activeChatId || !activeSessionId) return; const newLabel = event.target.value; const phone = contactInfoModal.dataset.phone; if (!phone || normalizePhoneNumber(activeChatId.replace(/@c\.us$/,'')) !== phone) { console.warn("Label change attempt in modal, but active chat doesn't match modal phone."); return; } if (!chatLabels[activeSessionId]) chatLabels[activeSessionId] = {}; chatLabels[activeSessionId][activeChatId] = newLabel; renderAllChats(); updateChatHeaderLabel(newLabel); sendSocketMessage({ type: 'changeLabel', sessionId: activeSessionId, chatId: activeChatId, label: newLabel }); showToast(`מעדכן תגית ל: ${getLabelInfo(newLabel).text}...`, 'info'); }
function updateContactInfoModalIfNeeded() { if (contactInfoModal?.style.display === 'flex') { const phone = contactInfoModal.dataset.phone; if (phone && activeChatId && normalizePhoneNumber(activeChatId.replace(/@c\.us$/,'')) === phone) { console.log(`Contact Info modal is open for ${phone}, refreshing data...`); openContactInfoModal(phone); } } }

// --- Chat Filters ---
function setupChatFilters() {
  filterAllBtn?.addEventListener('click', () => setChatFilter('all'));
  filterUnreadBtn?.addEventListener('click', () => setChatFilter('unread'));
  filterFavoriteBtn?.addEventListener('click', () => setChatFilter('favorite'));
}

function setChatFilter(filterType) {
  if (activeChatFilter === filterType) return; // No change

  activeChatFilter = filterType;
  console.log(`Chat filter set to: ${filterType}`);

  // Update button visual state
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`filter-${filterType}-btn`)?.classList.add('active');

  // Re-render the chat list with the new filter
  renderAllChats();
}


// --- DOMContentLoaded Listener ---
document.addEventListener('DOMContentLoaded', () => {
  initializeAuth(); initThemeToggle();
  document.addEventListener('click', (e) => { if (emojiPanel?.classList.contains('visible') && !emojiPanel.contains(e.target) && e.target !== emojiBtn) emojiPanel.classList.remove('visible'); if (fileUploadPanel?.classList.contains('visible') && !fileUploadPanel.contains(e.target) && e.target !== attachmentBtn) fileUploadPanel.classList.remove('visible'); if (recordingUI?.classList.contains('visible') && mediaRecorder?.state !== 'recording' && !recordingUI.contains(e.target) && e.target !== voiceBtn && !voiceBtn?.contains(e.target)) recordingUI.classList.remove('visible'); if (muteInterface?.classList.contains('visible') && !muteInterface.contains(e.target) && e.target !== muteButton && !muteButton?.contains(e.target)) hideMuteInterface(); const isClickInsideMainMenu = e.target.closest('#chat-context-menu'); const isClickInsideSubMenu = e.target.closest('#label-selection-menu'); const isOpeningSubMenu = e.target.closest('#change-label-chat'); if (!isClickInsideMainMenu && !isClickInsideSubMenu && !e.target.closest('#message-context-menu') && !e.target.closest('.message-options') && !e.target.closest('.chat-actions')) { closeOtherContextMenus(); } else if (isClickInsideMainMenu && !isOpeningSubMenu && labelSelectionMenu?.style.display === 'block') { if (labelSelectionMenu) labelSelectionMenu.style.display = 'none'; } else if (!e.target.closest('#message-context-menu') && !e.target.closest('.message-options')) { if(messageContextMenu) messageContextMenu.style.display = 'none'; } if (!e.target.closest('.chat-actions')) { closeChatActionsMenu(); } });
  const logoutBtn = document.createElement('i'); logoutBtn.className='fas fa-sign-out-alt logout-btn icon-btn'; logoutBtn.style.cursor='pointer'; logoutBtn.title='התנתק'; const actionsCont = document.querySelector('.chat-actions'); const themeBtn = document.querySelector('.theme-toggle-btn'); if(actionsCont){ if(themeBtn) actionsCont.insertBefore(logoutBtn, themeBtn); else actionsCont.appendChild(logoutBtn); }
});