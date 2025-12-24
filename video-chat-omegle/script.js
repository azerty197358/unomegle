window.addEventListener('DOMContentLoaded', () => {
  // ---------------------- SOCKET ----------------------
  const socket = io();

  // ---------------------- DOM ELEMENTS ----------------------
  const notifyBell       = document.getElementById('notifyIcon');
  const notifyDot        = document.getElementById('notifyDot');
  const notifyMenu       = document.getElementById('notifyMenu');
  const localVideo       = document.getElementById('localVideo');
  const remoteVideo      = document.getElementById('remoteVideo');
  const localSpinner     = document.getElementById('localSpinner');
  const remoteSpinner    = document.getElementById('remoteSpinner');
  const reportBtn        = document.getElementById('reportBtn');
  const micBtn           = document.getElementById('micBtn');
  const chatMessages     = document.getElementById('chatMessages');
  const chatInput        = document.getElementById('chatInput');
  const sendBtn          = document.getElementById('sendBtn');
  const skipBtn          = document.getElementById('skipBtn');
  const exitBtn          = document.getElementById('exitBtn');

  // ---------------------- قائمة الإعلانات ----------------------
  const adVideosList = [
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_081055765.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/Single%20girl%20video%20chat%20-%20Video%20Calls%20Apps%20(360p,h264).mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251221_153328953.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_122947959.mp4',
    'https://raw.githubusercontent.com/azerty197358/myads/main/YouCut_20251224_123428027.mp4'
  ];
  let currentAdIndex = 0;
  let isAdPlaying    = false;
  let adVideo        = null;

  // ---------------------- إنشاء عنصر الفيديو الإعلاني ----------------------
  function createAdVideoElement() {
    if (adVideo) adVideo.remove();
    adVideo = document.createElement('video');
    Object.assign(adVideo, {
      id: 'adVideo', autoplay: false, muted: true,
      playsInline: true, preload: 'auto', controls: false
    });
    Object.assign(adVideo.style, {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      objectFit: 'cover', zIndex: 100, display: 'none', backgroundColor: '#000'
    });
    remoteVideo.parentNode.appendChild(adVideo);
    return adVideo;
  }
  createAdVideoElement();

  // ---------------------- متغيّرات عامة ----------------------
  let localStream = null, peerConnection = null, partnerId = null, isInitiator = false;
  let micEnabled = true, isBanned = false, consecutiveSearchFails = 0;
  const activeTimers = new Set();
  let searchTimer = null, pauseTimer = null;
  const normalPauseDuration = 3000;
  const servers = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
  const reportedIds = new Set(), reportCounts = new Map();
  const bufferedRemoteCandidates = [];
  let makingOffer = false, ignoreOffer = false, keepAliveChannel = null;
  let lastPong = Date.now();
  const PING_INTERVAL = 4000, PONG_TIMEOUT = 11000;
  let statsInterval = null, pingTimer = null;
  const STATS_POLL_MS = 3000;
  const BITRATE_HIGH = 800_000, BITRATE_MEDIUM = 400_000, BITRATE_LOW = 160_000;

  // ---------------------- بصمة الجهاز ----------------------
  async function generateFingerprint() {
    try {
      const components = [
        navigator.userAgent, navigator.language, screen.colorDepth,
        screen.width, screen.height, navigator.hardwareConcurrency || 0,
        new Date().getTimezoneOffset(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || ''
      ];
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top'; ctx.font = '14px Arial';
      ctx.fillStyle = '#f60'; ctx.fillRect(125,1,62,20);
      ctx.fillStyle = '#069'; ctx.fillText('fingerprint',2,15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('fingerprint',4,17);
      components.push(canvas.toDataURL());
      const audioCtx = new (window.OfflineAudioContext||window.webkitOfflineAudioContext)(1,44100,44100);
      const osc = audioCtx.createOscillator(); osc.type='triangle';
      osc.frequency.setValueAtTime(10000, audioCtx.currentTime);
      osc.connect(audioCtx.destination); osc.start(); osc.stop();
      components.push('audio-supported');
      const hashCode = str => { let h=0; for(let i=0;i<str.length;i++){ const c=str.charCodeAt(i); h=((h<<5)-h)+c; h=h&h; } return h.toString(16); };
      return hashCode(components.join('||'));
    } catch {
      return 'default-fp-' + Math.random().toString(36).slice(2,11);
    }
  }

  // ---------------------- مؤقّتات آمنة ----------------------
  function setSafeTimer(cb, delay) {
    const id = setTimeout(()=>{ activeTimers.delete(id); cb(); }, delay);
    activeTimers.add(id); return id;
  }
  function clearSafeTimer(id) { if(id){ clearTimeout(id); activeTimers.delete(id); } }
  function clearAllTimers() {
    activeTimers.forEach(id=>clearTimeout(id)); activeTimers.clear();
    if(statsInterval){ clearInterval(statsInterval); statsInterval=null; }
    if(pingTimer)   { clearInterval(pingTimer);    pingTimer   =null; }
  }

  // ---------------------- إرسال آمن ----------------------
  function safeEmit(event, data) {
    try {
      if(socket.connected){ socket.emit(event,data); return true; }
      console.warn(`Socket not connected, cannot emit ${event}`); return false;
    } catch(e) { console.error(`Error emitting ${event}:`,e); return false; }
  }

  // ---------------------- مساعدات واجهة ----------------------
  function addMessage(msg, type='system') {
    const d=document.createElement('div'); d.className=`msg ${type}`; d.textContent=msg;
    const typing=document.querySelector('.msg.system[style*="italic"]');
    if(typing&&typing.parentNode===chatMessages) chatMessages.insertBefore(d,typing);
    else chatMessages.appendChild(d);
    chatMessages.scrollTop=chatMessages.scrollHeight;
  }
  function updateStatusMessage(msg) {
    let s=document.getElementById('statusMessage');
    if(!s){ s=document.createElement('div'); s.id='statusMessage'; s.className='msg status'; chatMessages.appendChild(s); }
    s.textContent=msg; chatMessages.scrollTop=chatMessages.scrollHeight;
  }
  function pushAdminNotification(text) {
    const item=document.createElement('div'); item.className='notify-item'; item.textContent=text;
    notifyMenu.prepend(item);
    const empty=notifyMenu.querySelector('.notify-empty');
    if(empty) empty.remove();
  }
  function ensureNotifyEmpty() {
    if(notifyMenu.children.length===0){ const d=document.createElement('div'); d.textContent='No notifications'; d.className='notify-empty'; notifyMenu.appendChild(d); }
  }

  // ---------------------- buffer candidates ----------------------
  function bufferRemoteCandidate(c){ bufferedRemoteCandidates.push(c); }
  function flushBufferedCandidates() {
    while(bufferedRemoteCandidates.length&&peerConnection){
      const c=bufferedRemoteCandidates.shift();
      peerConnection.addIceCandidate(c).catch(()=>{});
    }
  }

  // ---------------------- bitrate adaptation ----------------------
  async function setSenderMaxBitrate(bps) {
    if(!peerConnection) return;
    try {
      const senders=peerConnection.getSenders();
      for(const sender of senders){
        if(!sender.track||sender.track.kind!=='video') continue;
        const params=sender.getParameters();
        if(!params.encodings) params.encodings=[{}];
        params.encodings=params.encodings.map(enc=>({...enc,maxBitrate:bps}));
        await sender.setParameters(params);
      }
    } catch(e){ console.debug('setSenderMaxBitrate failed',e); }
  }

  // ---------------------- تشغيل الإعلان (ترتيبي) ----------------------
  function playAdVideo() {
    if(isAdPlaying||!adVideosList.length){ startSearchLoop(); return; }
    clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer);
    searchTimer=pauseTimer=null;
    isAdPlaying=true;
    const adUrl=adVideosList[currentAdIndex];
    currentAdIndex=(currentAdIndex+1)%adVideosList.length;
    updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝');
    adVideo.onerror=()=>{ console.error('Ad load error:',adUrl); hideAdVideo(); };
    adVideo.oncanplay=()=>{ adVideo.play().catch(()=> document.addEventListener('click',tryPlayAdOnClick,{once:true}); ); };
    adVideo.onended=hideAdVideo;
    adVideo.src=adUrl;
    adVideo.style.display='block'; remoteVideo.style.display='none';
    const adTimeout=setSafeTimer(hideAdVideo,5000);
    function tryPlayAdOnClick(){ adVideo.play().catch(()=>{}); }
    function hideAdVideo() {
      if(!isAdPlaying) return;
      clearSafeTimer(adTimeout); document.removeEventListener('click',tryPlayAdOnClick);
      adVideo.pause(); adVideo.style.display='none'; remoteVideo.style.display='block'; adVideo.src='';
      isAdPlaying=false; consecutiveSearchFails=0;
      updateStatusMessage('Searching...'); startSearchLoop();
    }
  }

  // ---------------------- تنظيف الاتصال ----------------------
  function cleanupConnection() {
    console.log('Cleaning up connection...');
    clearAllTimers();
    if(peerConnection){
      try {
        if(keepAliveChannel){ keepAliveChannel.close(); keepAliveChannel=null; }
        peerConnection.close();
      } catch(e){ console.error('Error closing peer',e); }
      peerConnection=null;
    }
    if(remoteVideo) remoteVideo.srcObject=null;
    bufferedRemoteCandidates.length=0; partnerId=null; isInitiator=false;
    makingOffer=false; ignoreOffer=false;
  }

  // ---------------------- إدارة الإشعارات ----------------------
  notifyBell.onclick=e=>{ e.stopPropagation(); if(notifyDot) notifyDot.style.display='none'; notifyBell.classList.remove('shake'); notifyMenu.style.display=notifyMenu.style.display==='block'?'none':'block'; };
  document.onclick=()=>notifyMenu.style.display='none';
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') notifyMenu.style.display='none'; });

  // ---------------------- كتابة ----------------------
  const typingIndicator=document.createElement('div'); typingIndicator.className='msg system'; typingIndicator.style.display='none'; typingIndicator.style.fontStyle='italic'; typingIndicator.textContent='Stranger is typing...'; chatMessages.appendChild(typingIndicator);
  let typing=false, typingTimer=null; const TYPING_PAUSE=1500;
  function sendTyping(){ if(!partnerId||isBanned) return; if(!typing){ typing=true; safeEmit('typing',{to:partnerId}); } clearSafeTimer(typingTimer); typingTimer=setSafeTimer(()=>{ typing=false; safeEmit('stop-typing',{to:partnerId}); },TYPING_PAUSE); }
  chatInput.oninput=()=>{ if(!chatInput.disabled&&!isBanned) sendTyping(); };

  // ---------------------- دردشة ----------------------
  function sendMessage(){ if(isBanned) return; const msg=chatInput.value.trim(); if(!msg||!partnerId) return; addMessage(msg,'you'); safeEmit('chat-message',{to:partnerId,message:msg}); chatInput.value=''; typing=false; safeEmit('stop-typing',{to:partnerId}); }
  sendBtn.onclick=sendMessage; chatInput.onkeypress=e=>{ if(e.key==='Enter'&&!isBanned) sendMessage(); };

  // ---------------------- ميكروفون ----------------------
  function updateMicButton(){ micBtn.textContent=micEnabled?'🎤':'🔇'; micBtn.disabled=!localStream||isBanned; micBtn.style.opacity=(localStream&&!isBanned)?'1':'0.8'; }
  micBtn.onclick=()=>{ if(!localStream||isBanned) return; micEnabled=!micEnabled; localStream.getAudioTracks().forEach(t=>t.enabled=micEnabled); updateMicButton(); };

  // ---------------------- spinners ----------------------
  try{ if(localSpinner) localSpinner.style.display='none'; }catch{}
  function showRemoteSpinnerOnly(show){ if(remoteSpinner) remoteSpinner.style.display=show?'block':'none'; if(remoteVideo) remoteVideo.style.display=show?'none':'block'; if(localVideo) localVideo.style.display='block'; }
  function hideAllSpinners(){ if(remoteSpinner) remoteSpinner.style.display='none'; if(remoteVideo) remoteVideo.style.display='block'; if(localVideo) localVideo.style.display='block'; }

  // ---------------------- لقطة شاشة ----------------------
  function captureRemoteVideoFrame(){ return new Promise((resolve,reject)=>{ try{ const v=remoteVideo; if(!v||!v.srcObject) return reject(new Error('Remote video not available')); const w=v.videoWidth||v.clientWidth||640, h=v.videoHeight||v.clientHeight||480; if(!w||!h){ setTimeout(()=>{ const w2=v.videoWidth||v.clientWidth||640, h2=v.videoHeight||v.clientHeight||480; if(!w2||!h2) return reject(new Error('No frames')); const c2=document.createElement('canvas'); c2.width=w2; c2.height=h2; const x=c2.getContext('2d'); x.drawImage(v,0,0,w2,h2); resolve(c2.toDataURL('image/png')); },250); return; } const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d'); ctx.drawImage(v,0,0,w,h); resolve(canvas.toDataURL('image/png')); }catch(err){ reject(err); } }); }

  // ---------------------- تقرير ----------------------
  if(reportBtn){ reportBtn.style.display='flex'; reportBtn.onclick=async()=>{ if(!partnerId){ updateStatusMessage('No user to report.'); return; } const prev=reportCounts.get(partnerId)||0; const now=prev+1; reportCounts.set(partnerId,now); reportedIds.add(partnerId); safeEmit('report',{partnerId}); safeEmit('skip'); if(now===1){ try{ addMessage('Capturing screenshot for admin review...','system'); const image=await captureRemoteVideoFrame(); safeEmit('admin-screenshot',{image,partnerId}); addMessage('📋 A report about this user has been sent ✉️⚠️. Action is being reviewed 🔍⏳.','system'); }catch(err){ console.error('Screenshot failed',err); addMessage('Failed to capture screenshot (no remote frame).','system'); } } cleanupConnection(); disableChat(); updateStatusMessage('You reported the user — skipping...'); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); consecutiveSearchFails=0; startSearchLoop(); }; }

  // ---------------------- دردشة UI ----------------------
  function enableChat(){ chatInput.disabled=isBanned; sendBtn.disabled=isBanned; }
  function disableChat(){ chatInput.disabled=true; sendBtn.disabled=true; }

  // ---------------------- بحث شريك ----------------------
  function startSearchLoop() {
    if(isBanned){ updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️'); showRemoteSpinnerOnly(false); return; }
    if(partnerId||isAdPlaying) return;
    showRemoteSpinnerOnly(true); updateStatusMessage('Searching...'); safeEmit('find-partner');
    clearSafeTimer(searchTimer);
    searchTimer=setSafeTimer(()=>{
      if(!partnerId&&!isAdPlaying){ safeEmit('stop'); showRemoteSpinnerOnly(false); consecutiveSearchFails++; if(consecutiveSearchFails>=3){ playAdVideo(); return; } clearSafeTimer(pauseTimer); pauseTimer=setSafeTimer(()=>startSearchLoop(),normalPauseDuration); }
    },3500);
  }

  async function startSearch() {
    if(isBanned){ updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️'); showRemoteSpinnerOnly(false); return; }
    const mediaReady=await initMedia(); if(!mediaReady){ updateStatusMessage('Media initialization failed. Please allow camera/mic access.'); return; }
    cleanupConnection(); chatMessages.innerHTML=''; chatMessages.appendChild(typingIndicator); showRemoteSpinnerOnly(true); skipBtn.disabled=false; consecutiveSearchFails=0; startSearchLoop();
  }

  skipBtn.onclick=()=>{ if(isBanned) return; safeEmit('skip'); updateStatusMessage('You skipped.'); disableChat(); cleanupConnection(); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); consecutiveSearchFails=0; startSearchLoop(); };

  // ---------------------- socket events ----------------------
  socket.on('waiting',msg=>{ if(!isBanned) updateStatusMessage(msg); });
  socket.on('chat-message',({message})=>{ if(!isBanned) addMessage(message,'them'); });
  socket.on('typing',()=>{ if(!isBanned){ typingIndicator.style.display='block'; chatMessages.scrollTop=chatMessages.scrollHeight; } });
  socket.on('stop-typing',()=>{ if(!isBanned) typingIndicator.style.display='none'; });
  socket.on('adminMessage',msg=>{ if(notifyDot) notifyDot.style.display='block'; notifyBell.classList.add('shake'); pushAdminNotification('📢 '+msg); addMessage('📢 Admin: '+msg,'system'); });
  socket.on('banned',({message})=>{ isBanned=true; addMessage(message||'You are banned.','system'); showRemoteSpinnerOnly(true); updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️'); cleanupConnection(); disableChat(); if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; } if(localVideo) localVideo.srcObject=null; updateMicButton(); });
  socket.on('unbanned',({message})=>{ isBanned=false; addMessage(message||'You have been unbanned.','system'); updateStatusMessage('You have been unbanned.'); startSearch(); });
  socket.on('partner-disconnected',()=>{ if(!isBanned){ updateStatusMessage('Partner disconnected.'); disableChat(); cleanupConnection(); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); consecutiveSearchFails=0; setSafeTimer(startSearchLoop,500); } });
  socket.on('partner-found',async data=>{ if(isBanned){ safeEmit('skip'); return; } const foundId=data?.id||data?.partnerId; if(!foundId){ console.error('Invalid partner data:',data); updateStatusMessage('Invalid partner data. Retrying...'); setSafeTimer(startSearchLoop,1000); return; } if(reportedIds.has(foundId)){ safeEmit('skip'); updateStatusMessage('Found reported user — skipping...'); cleanupConnection(); setSafeTimer(startSearchLoop,200); return; } partnerId=foundId; isInitiator=!!data.initiator; hideAllSpinners(); updateStatusMessage('Connecting...'); consecutiveSearchFails=0; try{ createPeerConnection(); if(isInitiator){ makingOffer=true; const offer=await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); safeEmit('signal',{to:partnerId,data:offer}); } }catch(e){ console.error('Failed to create peer/offer:',e); updateStatusMessage('Connection setup failed. Retrying...'); cleanupConnection(); setSafeTimer(startSearchLoop,1000); }finally{ makingOffer=false; } });
  socket.on('signal',async({from,data})=>{ if(isBanned) return; if(!from||!data){ console.error('Invalid signal:',{from,data}); return; } if(partnerId&&partnerId!==from){ console.warn('Signal from unexpected partner:',from,'expected:',partnerId); return; } if(!peerConnection){ try{ createPeerConnection(); }catch(e){ console.error('Failed to create peer for signal:',e); return; } } if(data.candidate&&!peerConnection.remoteDescription){ bufferRemoteCandidate(data.candidate); return; } try{ if(data.type==='offer'){ const offerCollision=(makingOffer||peerConnection.signalingState!=='stable'); ignoreOffer=!isInitiator&&offerCollision; if(ignoreOffer) return; await peerConnection.setRemoteDescription(data); const answer=await peerConnection.createAnswer(); await peerConnection.setLocalDescription(answer); safeEmit('signal',{to:from,data:answer}); }else if(data.type==='answer'){ await peerConnection.setRemoteDescription(data); }else if(data.candidate){ await peerConnection.addIceCandidate(data.candidate); } }catch(e){ console.error('Signal handling error:',e); updateStatusMessage('Signal processing failed.'); } });

  // ---------------------- WebRTC ----------------------
  function createPeerConnection() {
    if(peerConnection){ try{ peerConnection.close(); }catch{} peerConnection=null; }
    peerConnection=new RTCPeerConnection(servers); makingOffer=false; ignoreOffer=false;
    if(localStream) localStream.getTracks().forEach(t=>peerConnection.addTrack(t,localStream));
    if(isInitiator){ try{ keepAliveChannel=peerConnection.createDataChannel('keepAlive',{ordered:true}); setupKeepAliveChannel(keepAliveChannel); }catch{ keepAliveChannel=null; } }else{ peerConnection.ondatachannel=ev=>{ keepAliveChannel=ev.channel; setupKeepAliveChannel(keepAliveChannel); }; }
    peerConnection.ontrack=e=>{ if(!e.streams||!e.streams.length){ console.error('No streams in ontrack'); return; } remoteVideo.srcObject=e.streams[0]; enableChat(); updateStatusMessage('Connected'); showRemoteSpinnerOnly(false); flushBufferedCandidates(); consecutiveSearchFails=0; startStatsMonitor(); };
    peerConnection.onicecandidate=e=>{ if(e.candidate&&partnerId) safeEmit('signal',{to:partnerId,data:{candidate:e.candidate}}); };
    peerConnection.onconnectionstatechange=()=>{ if(!peerConnection) return; const s=peerConnection.connectionState; console.debug('connectionState:',s); if(s==='connected'){ updateStatusMessage('Hello 👋 You\'ve been contacted by a stranger Say hello 😊🤝'); consecutiveSearchFails=0; }else if(['disconnected','failed','closed'].includes(s)){ if(!isBanned){ updateStatusMessage('Connection lost.'); disableChat(); cleanupConnection(); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); consecutiveSearchFails=0; setSafeTimer(startSearchLoop,500); } } };
    peerConnection.onnegotiationneeded=async()=>{ if(!peerConnection||makingOffer||!partnerId) return; try{ makingOffer=true; const offer=await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); safeEmit('signal',{to:partnerId,data:offer}); }catch(e){ console.error('Negotiation error:',e); }finally{ makingOffer=false; } };
  }

  // ---------------------- KeepAlive ----------------------
  function setupKeepAliveChannel(dc) {
    if(!dc) return;
    dc.onopen=()=>{ lastPong=Date.now(); startPingLoop(); };
    dc.onmessage=ev=>{ if(!ev.data) return; try{ const msg=JSON.parse(ev.data); if(msg.type==='ping') dc.send(JSON.stringify({type:'pong',ts:Date.now()})); else if(msg.type==='pong') lastPong=Date.now(); }catch(e){ console.error('KeepAlive parse error:',e); } };
    dc.onclose=()=>{ console.debug('keepAlive closed'); stopPingLoop(); };
    dc.onerror=err=>console.error('keepAlive error:',err);
  }
  function startPingLoop() {
    stopPingLoop();
    pingTimer=setInterval(()=>{
      if(!keepAliveChannel||keepAliveChannel.readyState!=='open'){ stopPingLoop(); return; }
      try{ keepAliveChannel.send(JSON.stringify({type:'ping',ts:Date.now()})); }catch(e){ console.error('Ping send error:',e); stopPingLoop(); }
      if(Date.now()-lastPong>PONG_TIMEOUT){ console.warn('PONG timeout -> disconnect'); stopPingLoop(); cleanupConnection(); clearSafeTimer(searchTimer); clearSafeTimer(pauseTimer); consecutiveSearchFails=0; setSafeTimer(startSearchLoop,500); }
    },PING_INTERVAL);
  }
  function stopPingLoop(){ if(pingTimer){ clearInterval(pingTimer); pingTimer=null; } }

  // ---------------------- مراقبة الإحصائيات ----------------------
  function startStatsMonitor() {
    stopStatsMonitor();
    statsInterval=setInterval(async()=>{
      if(!peerConnection||peerConnection.connectionState!=='connected'){ stopStatsMonitor(); return; }
      try {
        const stats=await peerConnection.getStats(null); let outbound=null, remoteInbound=null;
        stats.forEach(r=>{ if(r.type==='outbound-rtp'&&r.kind==='video') outbound=r; if(r.type==='remote-inbound-rtp'&&r.kind==='video') remoteInbound=r; });
        let loss=0; if(outbound?.packetsSent>0){ const lost=(remoteInbound?.packetsLost??0); const sent=(remoteInbound?.packetsReceived??0)+lost; loss=(sent>0)?lost/sent:0; }
        let rtt=0; stats.forEach(r=>{ if(r.type==='candidate-pair'&&r.currentRtt) rtt=r.currentRtt; });
        if(loss>0.08||rtt>0.5) await setSenderMaxBitrate(BITRATE_LOW); else if(loss>0.03||rtt>0.25) await setSenderMaxBitrate(BITRATE_MEDIUM); else await setSenderMaxBitrate(BITRATE_HIGH);
      }catch(e){ console.debug('Stats monitor error',e); }
    },STATS_POLL_MS);
  }
  function stopStatsMonitor(){ if(statsInterval){ clearInterval(statsInterval); statsInterval=null; } }

  // ---------------------- EXIT ----------------------
  exitBtn.onclick=()=>{ cleanupConnection(); if(localStream){ localStream.getTracks().forEach(t=>t.stop()); } location.href='index.html'; };

  // ---------------------- تهيئة الوسائط مع إعادة المحاولة ----------------------
  let mediaRetryCount=0; const MAX_MEDIA_RETRIES=5;
  async function initMedia() {
    if(isBanned){ updateStatusMessage('⛔ You have been banned for 24 hours 🕐 for engaging in inappropriate behavior 🚫 and violating our policy terms 📜. ⚠️'); return false; }
    if(localStream) return true;
    try {
      localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      localVideo.srcObject=localStream; mediaRetryCount=0; updateMicButton(); return true;
    } catch(e) {
      console.error('Media error (attempt '+mediaRetryCount+'):',e);
      if(mediaRetryCount<MAX_MEDIA_RETRIES){
        mediaRetryCount++; updateStatusMessage(`Media access failed. Retrying (${mediaRetryCount}/${MAX_MEDIA_RETRIES})...`);
        await new Promise(r=>setTimeout(r,1500)); return initMedia();
      }
      updateStatusMessage('Camera/Mic access denied after multiple attempts. Please check permissions.');
      localStream=null; updateMicButton(); return false;
    }
  }

  // ---------------------- بدء التشغيل ----------------------
  async function initialize() {
    ensureNotifyEmpty(); updateMicButton();
    try{ const fp=await generateFingerprint(); safeEmit('identify',{fingerprint:fp}); }catch(e){ console.error('Fingerprint failed',e); }
    startSearch();
  }
  initialize();

  // ---------------------- معالجة الأخطاء العامة ----------------------
  window.addEventListener('error',e=>{ console.error('Global error:',e.error); updateStatusMessage('An unexpected error occurred. Refreshing...'); setSafeTimer(()=>location.reload(),3000); });
  window.addEventListener('unhandledrejection',e=>{ console.error('Unhandled rejection:',e.reason); updateStatusMessage('Connection error detected. Recovering...'); setSafeTimer(startSearchLoop,1000); });
  window.onbeforeunload=()=>{ safeEmit('stop'); cleanupConnection(); if(localStream){ localStream.getTracks().forEach(t=>t.stop()); } };
});
