// ============================================================
// BUKASON Assistant — app logic
// Handles: authentication, chat, mode switching, cloud history,
// the report form, and PWA install prompt.
// ============================================================

let supabase = null;
let currentUser = null;
let mode = 'academics';
let history = [];
let viewingHistory = false;

const MODE_LABELS = { academics: 'Academics', business: 'Business', general: 'General' };

const CHIPS = {
  academics: [
    "Explain photosynthesis simply",
    "How is JAMB scored?",
    "Help me plan WAEC revision",
    "What's the UTME cut-off mark meaning?"
  ],
  business: [
    "How can a student start earning online?",
    "Write my CV in 2 minutes",
    "What skill should I learn to earn in dollars?",
    "How do I price my first gig?"
  ],
  general: [
    "What can this bot do?",
    "Give me a study + hustle weekly plan",
    "How do I stay consistent with school and side hustle?",
    "Explain a topic I'm stuck on"
  ]
};

const SYSTEM_FORMAT_RULE = " Format your response using Markdown: short paragraphs, **bold** for key terms, numbered or bulleted lists for steps, and `code` or fenced code blocks for anything technical. No LaTeX or math notation — write formulas in plain words/numbers instead. Keep it mobile-friendly: avoid long unbroken paragraphs.";
const SYSTEM_PROMPTS = {
  academics: "You are the BUKASON Academics Assistant, built for Nigerian university and secondary school students (JAMB, WAEC, NECO, university coursework). Explain things simply and clearly, use short paragraphs or numbered steps, and where useful give a Nigerian-context example. Keep answers focused — this is a mobile chat. Be warm and direct." + SYSTEM_FORMAT_RULE,
  business: "You are the BUKASON Business Assistant, built for Nigerian students who want to start earning or build something of their own, with little or no starting capital. Give specific, realistic, low-cost steps suited to the Nigerian market. Keep answers short and mobile-friendly." + SYSTEM_FORMAT_RULE,
  general: "You are the BUKASON Assistant, a helpful guide for Nigerian students on academics and business. Keep answers short, clear, and practical." + SYSTEM_FORMAT_RULE
};

// ---------------- DOM refs ----------------
const authScreen = document.getElementById('authScreen');
const authTabs = document.querySelectorAll('.auth-tab');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const authError = document.getElementById('authError');
const authNotice = document.getElementById('authNotice');
const authLoading = document.getElementById('authLoading');
const switchLine = document.getElementById('switchLine');
const toSignup = document.getElementById('toSignup');

const chatEl = document.getElementById('chat');
const introEl = document.getElementById('intro');
const chipsEl = document.getElementById('chips');
const inputEl = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const attachPreviewRow = document.getElementById('attachPreviewRow');
const attachErrorEl = document.getElementById('attachError');

const menuOverlay = document.getElementById('menuOverlay');
const menuOpenBtn = document.getElementById('menuOpenBtn');
const menuItems = document.querySelectorAll('.menu-item[data-mode], .menu-item[data-menu]');
const modeMenuItems = document.querySelectorAll('.menu-item[data-mode]');
const currentModeLabel = document.getElementById('currentModeLabel');
const menuWho = document.getElementById('menuWho');
const menuEmail = document.getElementById('menuEmail');
const logoutBtn = document.getElementById('logoutBtn');

// ---------------- Auth tab switching ----------------
authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    authTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    loginForm.style.display = isLogin ? 'block' : 'none';
    signupForm.style.display = isLogin ? 'none' : 'block';
    switchLine.innerHTML = isLogin
      ? 'New here? <span id="toSignup">Create an account</span>'
      : 'Already have an account? <span id="toLogin">Log in</span>';
    hideAuthError();
    hideAuthNotice();
    wireSwitchLine();
  });
});

function wireSwitchLine(){
  const s = document.getElementById('toSignup');
  const l = document.getElementById('toLogin');
  if (s) s.addEventListener('click', () => document.querySelector('.auth-tab[data-tab="signup"]').click());
  if (l) l.addEventListener('click', () => document.querySelector('.auth-tab[data-tab="login"]').click());
}
wireSwitchLine();

function showAuthError(msg){
  authError.textContent = msg;
  authError.style.display = 'block';
}
function hideAuthError(){
  authError.style.display = 'none';
}
function showAuthNotice(msg){
  authNotice.textContent = msg;
  authNotice.style.display = 'block';
}
function hideAuthNotice(){
  authNotice.style.display = 'none';
}

// ---------------- Auth actions ----------------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  setAuthBusy(true);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  setAuthBusy(false);
  if (error) { showAuthError(error.message); return; }
  onAuthSuccess(data.user);
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAuthError();
  const full_name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const whatsapp = document.getElementById('signupWhatsapp').value.trim();
  const password = document.getElementById('signupPassword').value;
  setAuthBusy(true);
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { data: { full_name, whatsapp } }
  });
  setAuthBusy(false);
  if (error) { showAuthError(error.message); return; }
  if (data.user && !data.session) {
    document.querySelector('.auth-tab[data-tab="login"]').click();
    showAuthNotice("Account created! Check your email inbox (" + email + ") for a confirmation link, then log in here.");
    return;
  }
  onAuthSuccess(data.user);
});

function setAuthBusy(busy){
  authLoading.style.display = busy ? 'block' : 'none';
  document.getElementById('loginBtn').disabled = busy;
  document.getElementById('signupBtn').disabled = busy;
}

function onAuthSuccess(user){
  currentUser = user;
  authScreen.classList.add('hidden');
  const name = (user.user_metadata && user.user_metadata.full_name) || user.email;
  menuWho.textContent = name;
  menuEmail.textContent = user.email;
  renderChips();
  loadHistoryForMode(mode);
}

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  currentUser = null;
  history = [];
  chatEl.innerHTML = '';
  menuOverlay.classList.remove('open');
  authScreen.classList.remove('hidden');
});

// ---------------- Boot: wait for Supabase client, then check session ----------------
window.addEventListener('supabase-ready', async () => {
  supabase = window.supabaseClient;
  const { data } = await supabase.auth.getSession();
  if (data.session && data.session.user) {
    onAuthSuccess(data.session.user);
  }
});

// ---------------- Mode / menu ----------------
function renderChips(){
  chipsEl.innerHTML = '';
  CHIPS[mode].forEach(text=>{
    const c = document.createElement('div');
    c.className='chip';
    c.textContent=text;
    c.onclick=()=>{ inputEl.value=text; sendMessage(); };
    chipsEl.appendChild(c);
  });
}

menuOpenBtn.addEventListener('click', ()=>{ menuOverlay.classList.add('open'); });
menuOverlay.addEventListener('click', (e)=>{ if(e.target === menuOverlay) menuOverlay.classList.remove('open'); });

menuItems.forEach(item=>{
  item.addEventListener('click', ()=>{
    menuOverlay.classList.remove('open');
    if(item.dataset.menu === 'history'){
      viewingHistory = true;
      renderFullHistory();
      return;
    }
    modeMenuItems.forEach(b=>b.classList.remove('active'));
    item.classList.add('active');
    mode = item.dataset.mode;
    currentModeLabel.textContent = MODE_LABELS[mode];
    viewingHistory = false;
    renderChips();
    loadHistoryForMode(mode);
  });
});

// ---------------- Chat rendering ----------------
// Bot replies are rendered as sanitized Markdown (headings, lists, bold,
// code blocks, tables, etc). User messages are ALWAYS rendered as plain
// text via textContent — never as HTML — since that content is untrusted
// input and must never be interpreted as markup.
function renderBotMarkdown(bubble, text){
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    // CDN libs failed to load (offline/blocked) — fail safe to plain text.
    bubble.textContent = text;
    return;
  }
  const rawHtml = marked.parse(text, { breaks: true });
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ['p','br','strong','em','ul','ol','li','h1','h2','h3','h4',
      'blockquote','code','pre','a','table','thead','tbody','tr','th','td','hr'],
    ALLOWED_ATTR: ['href']
  });
  bubble.classList.add('md');
  bubble.innerHTML = cleanHtml;
  // Any links in AI output open safely in a new tab.
  bubble.querySelectorAll('a').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}

function addMessage(role, text, atts){
  if(introEl && introEl.parentNode){ introEl.remove(); }
  if(chipsEl && chipsEl.parentNode){ chipsEl.remove(); }
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role==='user' ? 'user' : 'bot');
  if(role!=='user'){
    const who = document.createElement('div');
    who.className='who';
    who.textContent='BUKASON';
    wrap.appendChild(who);
  }
  if(atts && atts.length){
    atts.forEach(a => {
      const box = document.createElement('div');
      if(a.mimeType && a.mimeType.startsWith('image/') && a.previewUrl){
        box.className = 'msg-attachment';
        const img = document.createElement('img');
        img.src = a.previewUrl;
        img.alt = a.name || 'attached image';
        box.appendChild(img);
      } else {
        box.className = 'msg-attachment doc';
        box.textContent = '📄 ' + (a.name || 'document');
      }
      wrap.appendChild(box);
    });
  }
  const bubble = document.createElement('div');
  bubble.className='bubble';
  if(role==='user'){
    bubble.textContent = text; // never render user input as HTML
  }else{
    renderBotMarkdown(bubble, text);
  }
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function addTyping(label){
  const wrap = document.createElement('div');
  wrap.className='msg bot';
  wrap.id='typingIndicator';
  const bubble = document.createElement('div');
  bubble.className='bubble';
  if(label){
    bubble.style.display='flex';
    bubble.style.alignItems='center';
    bubble.style.gap='8px';
    bubble.innerHTML = '<span>'+label.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))+'</span><div class="typing"><span></span><span></span><span></span></div>';
  }else{
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  }
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function removeTyping(){
  const t = document.getElementById('typingIndicator');
  if(t) t.remove();
}

// ---------------- Cloud history (Supabase) ----------------
async function loadHistoryForMode(m){
  chatEl.innerHTML = '';
  if(!currentUser){ chatEl.appendChild(introEl); chatEl.appendChild(chipsEl); return; }

  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('user_id', currentUser.id)
    .eq('mode', m)
    .order('created_at', { ascending: true });

  if(error || !data || data.length === 0){
    chatEl.appendChild(introEl);
    chatEl.appendChild(chipsEl);
    history = [];
    return;
  }

  history = data.map(d => ({ role: d.role, content: d.content }));
  data.forEach(d => addMessage(d.role === 'assistant' ? 'bot' : 'user', d.content));
}

async function renderFullHistory(){
  if(!currentUser) return;
  chatEl.innerHTML = '';
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, mode, created_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: true });

  if(error || !data || data.length === 0){
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;color:var(--sub);font-size:13px;padding:40px 20px;';
    empty.textContent = "No conversations yet — ask something first.";
    chatEl.appendChild(empty);
    return;
  }

  const modes = ['academics','business','general'];
  modes.forEach(m=>{
    const msgs = data.filter(d => d.mode === m);
    if(msgs.length === 0) return;
    const heading = document.createElement('div');
    heading.style.cssText = 'text-align:center;margin:18px 0 8px;color:var(--sub);font-size:11.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;';
    heading.textContent = MODE_LABELS[m];
    chatEl.appendChild(heading);
    msgs.forEach(d => addMessage(d.role === 'assistant' ? 'bot' : 'user', d.content));
  });
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function saveMessage(role, content){
  if(!currentUser) return;
  await supabase.from('messages').insert({
    user_id: currentUser.id,
    mode: mode,
    role: role,
    content: content
  });
}

// ---------------- Intro video (lazy — nothing loads until tapped) ----------------
const introVideoPlayBtn = document.getElementById('introVideoPlayBtn');
const introVideoEl = document.getElementById('introVideoEl');
if(introVideoPlayBtn && introVideoEl){
  introVideoPlayBtn.addEventListener('click', () => {
    introVideoPlayBtn.style.display = 'none';
    introVideoEl.style.display = 'block';
    introVideoEl.play().catch(()=>{}); // muted-autoplay restrictions don't apply post-tap, but guard anyway
  });
}

// ---------------- Attachments (upload + client-side validation) ----------------
// Files are uploaded directly from the browser to Supabase Storage (private
// bucket "attachments", RLS-scoped to the signed-in user's own folder), then
// only a short-lived signed URL is sent to the chat function. No file bytes
// ever pass through or are stored by the Netlify function itself.

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 8 MB
const MAX_PDF_BYTES = 15 * 1024 * 1024;    // 15 MB
const MAX_ATTACHMENTS = 3;

// Magic-byte signatures — never trust the browser-reported File.type alone.
const SIGNATURES = [
  { mime: 'image/png',  bytes: [0x89,0x50,0x4E,0x47] },
  { mime: 'image/jpeg', bytes: [0xFF,0xD8,0xFF] },
  { mime: 'image/gif',  bytes: [0x47,0x49,0x46,0x38] },
  { mime: 'application/pdf', bytes: [0x25,0x50,0x44,0x46] },
];

function sniffMimeFromBytes(bytes){
  for(const sig of SIGNATURES){
    if(sig.bytes.every((b,i) => bytes[i] === b)) return sig.mime;
  }
  // WEBP: "RIFF" .... "WEBP"
  if(bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 &&
     bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50){
    return 'image/webp';
  }
  return null;
}

function readFirstBytes(file, n){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file.slice(0, n));
  });
}

function sanitizeFilename(name){
  const base = (name || 'file').split(/[\\/]/).pop(); // strip any path
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  return cleaned || 'file';
}

function showAttachError(msg){
  attachErrorEl.textContent = msg;
  attachErrorEl.style.display = 'block';
  setTimeout(() => { attachErrorEl.style.display = 'none'; }, 4000);
}

let pendingAttachments = []; // { id, name, realMime, status, signedUrl, storagePath, previewUrl }

function renderAttachPreviews(){
  attachPreviewRow.innerHTML = '';
  attachPreviewRow.classList.toggle('show', pendingAttachments.length > 0);
  pendingAttachments.forEach(att => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (att.status === 'uploading' ? ' uploading' : '');
    if(att.realMime && att.realMime.startsWith('image/') && att.previewUrl){
      const img = document.createElement('img');
      img.src = att.previewUrl;
      chip.appendChild(img);
    } else {
      const doc = document.createElement('div');
      doc.className = 'doc-ic';
      doc.textContent = '📄 ' + att.name.slice(0, 14);
      chip.appendChild(doc);
    }
    if(att.status === 'uploading'){
      const spin = document.createElement('div');
      spin.className = 'spinner';
      chip.appendChild(spin);
    }
    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.type = 'button';
    rm.textContent = '×';
    rm.onclick = () => removeAttachment(att.id);
    chip.appendChild(rm);
    attachPreviewRow.appendChild(chip);
  });
}

function removeAttachment(id){
  const att = pendingAttachments.find(a => a.id === id);
  if(att && att.previewUrl) URL.revokeObjectURL(att.previewUrl);
  if(att && att.storagePath && currentUser){
    // best-effort cleanup; ignore failures
    supabase.storage.from('attachments').remove([att.storagePath]).catch(()=>{});
  }
  pendingAttachments = pendingAttachments.filter(a => a.id !== id);
  renderAttachPreviews();
}

async function handleFilesSelected(files){
  if(!currentUser){ showAttachError('Please log in first.'); return; }
  const room = MAX_ATTACHMENTS - pendingAttachments.length;
  if(room <= 0){ showAttachError('You can attach up to ' + MAX_ATTACHMENTS + ' files.'); return; }

  for(const file of Array.from(files).slice(0, room)){
    const id = 'a' + Date.now() + Math.random().toString(36).slice(2,7);
    const localAtt = { id, name: sanitizeFilename(file.name), status: 'uploading', realMime: null, previewUrl: null, storagePath: null, signedUrl: null };
    pendingAttachments.push(localAtt);
    renderAttachPreviews();

    try{
      const head = await readFirstBytes(file, 16);
      const realMime = sniffMimeFromBytes(head);
      if(!realMime){
        showAttachError(localAtt.name + ': unsupported file type.');
        removeAttachment(id);
        continue;
      }
      const isPdf = realMime === 'application/pdf';
      const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
      if(file.size > maxBytes){
        showAttachError(localAtt.name + ': too large (max ' + Math.round(maxBytes/1024/1024) + 'MB).');
        removeAttachment(id);
        continue;
      }

      localAtt.realMime = realMime;
      if(realMime.startsWith('image/')) localAtt.previewUrl = URL.createObjectURL(file);
      renderAttachPreviews();

      const ext = realMime === 'application/pdf' ? 'pdf' : realMime.split('/')[1];
      const storagePath = currentUser.id + '/' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.' + ext;

      const { error: upErr } = await supabase.storage.from('attachments').upload(storagePath, file, {
        contentType: realMime,
        upsert: false
      });
      if(upErr) throw upErr;

      const { data: signed, error: signErr } = await supabase.storage
        .from('attachments')
        .createSignedUrl(storagePath, 3600); // 1 hour, plenty for one message round-trip
      if(signErr) throw signErr;

      localAtt.status = 'ready';
      localAtt.storagePath = storagePath;
      localAtt.signedUrl = signed.signedUrl;
      renderAttachPreviews();
    }catch(err){
      showAttachError((localAtt.name || 'File') + ': upload failed — try again.');
      removeAttachment(id);
    }
  }
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if(e.target.files && e.target.files.length) handleFilesSelected(e.target.files);
  fileInput.value = ''; // allow selecting the same file again later
});

function clearAttachments(){
  // Note: does NOT revoke previewUrl blobs — ownership has passed to the
  // message bubble that was just rendered with them (see sendMessage()).
  pendingAttachments = [];
  renderAttachPreviews();
}

// ---------------- Image generation / editing (Phase 3 + 4) ----------------
const imageModeBtn = document.getElementById('imageModeBtn');
const imageModeBanner = document.getElementById('imageModeBanner');
const imageModeExit = document.getElementById('imageModeExit');
let imageModeActive = false;

function setImageMode(on){
  imageModeActive = on;
  imageModeBtn.classList.toggle('image-mode-active', on);
  imageModeBanner.classList.toggle('show', on);
  inputEl.placeholder = on ? "Describe the image to create or edit…" : "Type your question…";
}
imageModeBtn.addEventListener('click', () => setImageMode(!imageModeActive));
imageModeExit.addEventListener('click', () => setImageMode(false));

function addImageMessage(role, base64, mimeType, caption){
  if(introEl && introEl.parentNode){ introEl.remove(); }
  if(chipsEl && chipsEl.parentNode){ chipsEl.remove(); }
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role==='user' ? 'user' : 'bot');
  if(role!=='user'){
    const who = document.createElement('div');
    who.className='who';
    who.textContent='BUKASON';
    wrap.appendChild(who);
  }
  const dataUrl = 'data:' + mimeType + ';base64,' + base64;
  const box = document.createElement('div');
  box.className = 'gen-image-wrap';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = caption || 'Generated image';
  box.appendChild(img);
  wrap.appendChild(box);

  if(role !== 'user'){
    const actions = document.createElement('div');
    actions.className = 'gen-image-actions';
    const dl = document.createElement('a');
    dl.href = dataUrl;
    dl.download = 'bukason-image-' + Date.now() + '.png';
    dl.textContent = '⬇ Save image';
    actions.appendChild(dl);
    wrap.appendChild(actions);
  }
  if(caption){
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = caption;
    wrap.appendChild(bubble);
  }
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function sendImageGenRequest(){
  const prompt = inputEl.value.trim();
  const readyAtts = pendingAttachments.filter(a => a.status === 'ready' && a.realMime && a.realMime.startsWith('image/'));
  const stillUploading = pendingAttachments.some(a => a.status === 'uploading');

  if(stillUploading){ showAttachError('Still uploading — one moment.'); return; }
  if(!prompt){ showAttachError(readyAtts.length ? 'Say what to change about the image.' : 'Describe the image you want.'); return; }

  const isEdit = readyAtts.length > 0;
  const attsForDisplay = readyAtts.map(a => ({ mimeType: a.realMime, name: a.name, previewUrl: a.previewUrl }));
  const attsForApi = readyAtts.map(a => ({ url: a.signedUrl, mimeType: a.realMime, name: a.name }));

  inputEl.value = '';
  resetInputHeight();
  sendBtn.disabled = true;
  attachBtn.disabled = true;
  imageModeBtn.disabled = true;

  addMessage('user', prompt, attsForDisplay);
  const historyNote = prompt + (isEdit ? ' [image edit request, attached: ' + readyAtts.map(a=>a.name).join(', ') + ']' : ' [image generation request]');
  history.push({role:'user', content: historyNote});
  saveMessage('user', historyNote);
  clearAttachments();
  addTyping(isEdit ? 'Editing image…' : 'Generating image…');

  try{
    const response = await fetch("/.netlify/functions/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generateImage: true, prompt, attachments: attsForApi })
    });
    const data = await response.json();
    removeTyping();
    if(!response.ok || !data.image){
      const msg = data.error || "Couldn't generate that image — please try again.";
      addMessage('bot', msg);
    }else{
      addImageMessage('bot', data.image.base64, data.image.mimeType, data.text || '');
      const note = isEdit ? '[edited image generated]' : '[image generated: "' + prompt + '"]';
      history.push({role:'assistant', content: note});
      saveMessage('assistant', note);
    }
  }catch(err){
    removeTyping();
    addMessage('bot', "Network hiccup — please try again in a moment.");
  }finally{
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    imageModeBtn.disabled = false;
  }
}

// ---------------- Sending messages ----------------
async function sendMessage(){
  const text = inputEl.value.trim();
  const readyAtts = pendingAttachments.filter(a => a.status === 'ready');
  const stillUploading = pendingAttachments.some(a => a.status === 'uploading');

  if(!currentUser) return;
  if(stillUploading){ showAttachError('Still uploading — one moment.'); return; }
  if(!text && readyAtts.length === 0) return;

  if(viewingHistory){
    viewingHistory = false;
    loadHistoryForMode(mode);
  }
  inputEl.value='';
  resetInputHeight();
  sendBtn.disabled = true;
  attachBtn.disabled = true;

  const attsForDisplay = readyAtts.map(a => ({ mimeType: a.realMime, name: a.name, previewUrl: a.previewUrl }));
  const attsForApi = readyAtts.map(a => ({ url: a.signedUrl, mimeType: a.realMime, name: a.name }));
  const displayText = text || (readyAtts.length ? '(see attached)' : '');

  addMessage('user', displayText, attsForDisplay);

  // Stored/sent history stays text-only — signed URLs expire and shouldn't
  // be replayed into future turns as if still valid.
  const historyNote = readyAtts.length ? displayText + ' [attached: ' + readyAtts.map(a=>a.name).join(', ') + ']' : displayText;
  history.push({role:'user', content: historyNote});
  saveMessage('user', historyNote);
  clearAttachments();
  addTyping();

  try{
    const response = await fetch("/.netlify/functions/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: SYSTEM_PROMPTS[mode], history: history, attachments: attsForApi })
    });
    const data = await response.json();
    removeTyping();
    if(!response.ok){
      let msg = data.error || "Something went wrong — please try again.";
      if(data.debug && data.debug.length){ msg += "\\n\\n(debug: " + data.debug.join(' | ') + ")"; }
      addMessage('bot', msg);
    }else{
      const reply = data.text || "Sorry, I couldn't get a response — try again.";
      addMessage('bot', reply);
      history.push({role:'assistant', content:reply});
      saveMessage('assistant', reply);
    }
  }catch(err){
    removeTyping();
    addMessage('bot', "Network hiccup — please try again in a moment.");
  }finally{
    sendBtn.disabled = false;
    attachBtn.disabled = false;
  }
}

sendBtn.addEventListener('click', () => { imageModeActive ? sendImageGenRequest() : sendMessage(); });
// Enter now inserts a line break (default textarea behavior) — sending
// only happens via the send button, matching a multi-line chat input.
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});
function resetInputHeight(){ inputEl.style.height = 'auto'; }

// ---------------- PWA install ----------------
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});
function showInstallBanner(){
  if(document.getElementById('installBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'installBanner';
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:78px;background:#0A1830;color:#fff;border-radius:12px;padding:11px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;z-index:50;box-shadow:0 6px 20px rgba(0,0,0,.25);';
  bar.innerHTML = '<span>Add BUKASON to your home screen.</span>';
  const btn = document.createElement('button');
  btn.textContent = 'Add';
  btn.style.cssText = 'background:#D4AF37;color:#0A1830;border:none;border-radius:8px;padding:7px 12px;font-weight:600;font-size:13px;flex-shrink:0;';
  btn.onclick = async ()=>{
    bar.remove();
    if(deferredInstallPrompt){ deferredInstallPrompt.prompt(); deferredInstallPrompt = null; }
  };
  bar.appendChild(btn);
  document.body.appendChild(bar);
}

// ---------------- Report form ----------------
const reportOverlay = document.getElementById('reportOverlay');
const reportOpenBtn = document.getElementById('reportOpenBtn');
const reportCancelBtn = document.getElementById('reportCancelBtn');
const reportSubmitBtn = document.getElementById('reportSubmitBtn');
const reportStatus = document.getElementById('reportStatus');
const reportContact = document.getElementById('reportContact');
const reportMessage = document.getElementById('reportMessage');

reportOpenBtn.addEventListener('click', ()=>{ reportOverlay.classList.add('open'); reportStatus.style.display='none'; });
reportCancelBtn.addEventListener('click', ()=>{ reportOverlay.classList.remove('open'); });
reportOverlay.addEventListener('click', (e)=>{ if(e.target === reportOverlay) reportOverlay.classList.remove('open'); });

function encodeForm(data){
  return Object.keys(data).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k])).join('&');
}

reportSubmitBtn.addEventListener('click', async ()=>{
  const msg = reportMessage.value.trim();
  if(!msg){
    reportStatus.textContent = 'Please describe the issue first.';
    reportStatus.className = 'err'; reportStatus.style.display = 'block';
    return;
  }
  reportSubmitBtn.disabled = true;
  reportSubmitBtn.textContent = 'Sending…';
  try{
    await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({ 'form-name': 'bukason-report', contact: reportContact.value.trim(), message: msg })
    });
    reportStatus.textContent = 'Sent — thank you!';
    reportStatus.className = 'ok'; reportStatus.style.display = 'block';
    reportMessage.value=''; reportContact.value='';
    setTimeout(()=>{ reportOverlay.classList.remove('open'); }, 1200);
  }catch(err){
    reportStatus.textContent = 'Could not send — check your connection.';
    reportStatus.className = 'err'; reportStatus.style.display = 'block';
  }finally{
    reportSubmitBtn.disabled = false;
    reportSubmitBtn.textContent = 'Send';
  }
});
