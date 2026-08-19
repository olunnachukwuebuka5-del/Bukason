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

const SYSTEM_FORMAT_RULE = " Write in plain text only — no markdown (no asterisks, no #), no LaTeX or math notation, no special formatting. Use plain numbers, plain words, and line breaks only.";
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
function addMessage(role, text){
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
  const bubble = document.createElement('div');
  bubble.className='bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function addTyping(){
  const wrap = document.createElement('div');
  wrap.className='msg bot';
  wrap.id='typingIndicator';
  const bubble = document.createElement('div');
  bubble.className='bubble';
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
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

// ---------------- Sending messages ----------------
async function sendMessage(){
  const text = inputEl.value.trim();
  if(!text || !currentUser) return;
  if(viewingHistory){
    viewingHistory = false;
    loadHistoryForMode(mode);
  }
  inputEl.value='';
  sendBtn.disabled = true;
  addMessage('user', text);
  history.push({role:'user', content:text});
  saveMessage('user', text);
  addTyping();

  try{
    const response = await fetch("/.netlify/functions/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: SYSTEM_PROMPTS[mode], history: history })
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
  }
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', e=>{ if(e.key==='Enter') sendMessage(); });

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
