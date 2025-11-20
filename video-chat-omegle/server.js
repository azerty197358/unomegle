<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Random Video Chat</title>
  <style>
    * {
      box-sizing: border-box;
    }
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    body {
      background: #fff;
      color: #000;
      text-align: center;
      font-family: Arial, sans-serif;
      overflow: hidden; /* Prevents scrolling on desktop */
      direction: ltr; /* Support for English */
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    h1 {
      color: #f60;
      margin: 10px 0;
    }
    /* ====================== */
    .main-content {
      display: flex;
      flex: 1;
      justify-content: center;
      align-items: flex-start;
      gap: 30px;
      overflow: hidden;
      padding: 10px 20px;
    }
    /* The two screens with background and shadow */
    .videos {
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      gap: 20px;
      flex: 1;
      min-width: 320px;
      height: 100%;
      transform: translateX(10px);
      background: #f5f5f5;
      border-radius: 10px;
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
      padding: 15px;
    }
    .video-container {
      position: relative;
      width: 100%;
      aspect-ratio: 4 / 3;
      background: #000;
      border: 1px solid #ccc;
      border-radius: 5px;
      overflow: hidden;
    }
    .video-label {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(255, 255, 255, 0.7);
      padding: 5px 10px;
      border-radius: 5px;
      font-size: 14px;
      z-index: 10;
      color: #000;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #333;
      border: none;
    }
    /* Report button on remote video */
    .report-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: #ff0000;
      color: white;
      border: none;
      padding: 5px 10px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      z-index: 10;
      display: none; /* Show only when connected */
    }
    .report-btn:hover {
      background: #cc0000;
    }
    /* Spinner inside the screen */
    .video-spinner {
      display: none;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 5;
      color: #f60;
    }
    .video-spinner .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid rgba(255, 255, 255, 0.3);
      border-top: 3px solid #f60;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    .video-spinner span {
      display: block;
      margin-top: 10px;
      font-size: 14px;
      color: #fff;
    }
    /* Messages with background and shadow (unified) */
    .chat-container {
      flex: 1;
      min-width: 340px;
      background: #f5f5f5;
      border: 1px solid #ccc;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      height: 100%;
      transform: translateX(-10px);
      box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
      overflow: hidden;
      position: relative; /* To support absolute positioning for emoji */
    }
    /* Messages */
    .chat-messages {
      flex: 1;
      padding: 15px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      scrollbar-width: thin;
      scrollbar-color: #f60 #f5f5f5;
      background: #fff;
      scroll-behavior: smooth;
      -webkit-overflow-scrolling: touch; /* Smooth scrolling on iOS */
    }
    /* Show scrollbar on mobile too */
    .chat-messages::-webkit-scrollbar {
      width: 8px;
    }
    .chat-messages::-webkit-scrollbar-thumb {
      background-color: #f60;
      border-radius: 4px;
    }
    .chat-messages::-webkit-scrollbar-track {
      background-color: #f5f5f5;
    }
    .message {
      margin-bottom: 10px;
      padding: 8px 12px;
      border-radius: 18px;
      max-width: 80%;
      word-wrap: break-word;
      background: #e9e9e9;
      animation: fadeIn 0.3s ease-in; /* Smooth appearance effect */
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .message.you {
      background: #f60;
      color: white;
      align-self: flex-end;
    }
    .message.stranger {
      background: #007bff;
      color: white;
      align-self: flex-start;
    }
    .system-message {
      align-self: center;
      color: #888;
      font-style: italic;
      margin: 10px 0;
      padding: 5px;
      background: none;
    }
    /* Unified input area */
    .input-area {
      display: flex;
      align-items: center;
      background: #f1f1f1;
      padding: 10px;
      border-top: 1px solid #ccc;
      gap: 10px;
    }
    .input-area input {
      flex: 1;
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 5px;
      background: #fff;
      color: #000;
      outline: none;
    }
    .input-area input:focus {
      border-color: #f60;
    }
    .send-btn {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      padding: 10px;
      border-radius: 5px;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .send-btn:hover:not(:disabled) {
      background: #f60;
      color: white;
    }
    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    /* Buttons below messages */
    .controls {
      display: flex;
      justify-content: center;
      gap: 10px;
      padding: 10px;
    }
    .controls button {
      padding: 12px 25px;
      background: #f60;
      border: none;
      color: white;
      border-radius: 5px;
      cursor: pointer;
      font-size: 16px;
      transition: all 0.3s;
    }
    .controls button:hover:not(:disabled) {
      background: #e55;
      transform: translateY(-2px);
    }
    .controls button:disabled {
      background: #ccc;
      cursor: not-allowed;
      transform: none;
    }
    /* Pen button for mobile */
    #mobilePen {
      display: none;
      position: fixed;
      bottom: 80px;
      left: 20px;
      background: #f60;
      color: white;
      border: none;
      border-radius: 50%;
      width: 55px;
      height: 55px;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 0 10px rgba(0,0,0,0.3);
      z-index: 1000;
    }
    /* Loading state */
    .status-container {
      padding: 10px;
    }
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid #ccc;
      border-top: 2px solid #f60;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    /* ===================== Mobile ===================== */
    @media (max-width: 768px) {
      .main-content {
        flex-direction: column;
        gap: 15px;
        align-items: center;
        justify-content: flex-start;
      }
      .videos {
        transform: none;
        width: 100%;
        flex-direction: column; /* Change to vertical for stacking */
        justify-content: flex-start;
        align-items: center;
        height: auto;
        padding: 10px;
        gap: 10px;
      }
      .video-container {
        width: 80%; /* Reduce size to 80% for more space for messages */
        aspect-ratio: 16 / 9; /* Maintain aspect ratio but with smaller width */
      }
      .chat-container {
        transform: none;
        width: 100%;
        position: relative;
      }
      .chat-messages {
        /* Increase height to show more messages before scrolling */
        flex: 1;
        max-height: none;
        height: 40vh; /* Reduce to 40vh to save space for videos above, but show more */
        overflow-y: scroll;
        -webkit-overflow-scrolling: touch;
      }
      body {
        overflow-y: auto;
      }
      /* Hide pen as it's not needed now */
      #mobilePen {
        display: none;
      }
      .input-area {
        /* Sticky positioned for easy use */
        position: sticky;
        bottom: 0;
        z-index: 50;
      }
      /* Enlarge spinner on mobile */
      .video-spinner .spinner {
        width: 30px;
        height: 30px;
        border-width: 3px;
      }
      /* Report button on mobile */
      .report-btn {
        top: 5px;
        right: 5px;
        padding: 3px 6px;
        font-size: 10px;
      }
    }
    /* Ban overlay */
    #banOverlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      justify-content: center;
      align-items: center;
      z-index: 10000;
      text-align: center;
      padding: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Random Video Chat</h1>
    <div class="main-content">
      <div class="videos">
        <div class="video-container">
          <div class="video-label">You</div>
          <video id="localVideo" autoplay muted></video>
          <div class="video-spinner" id="localSpinner">
            <div class="spinner"></div>
            <span>Searching...</span>
          </div>
        </div>
        <div class="video-container">
          <div class="video-label">Stranger</div>
          <button class="report-btn" id="reportBtn">Report Porn</button>
          <video id="remoteVideo" autoplay></video>
          <div class="video-spinner" id="remoteSpinner">
            <div class="spinner"></div>
            <span>Searching...</span>
          </div>
        </div>
      </div>
 
      <div class="chat-container">
        <div class="chat-messages" id="chatMessages">
          <!-- Messages will be managed by script.js -->
        </div>
        <div class="input-area">
          <input type="text" id="chatInput" placeholder="Type a message..." disabled>
          <button class="send-btn" id="sendBtn" disabled>Send</button>
        </div>
      </div>
    </div>
    <div class="controls">
      <button id="startBtn">Start</button>
      <button id="skipBtn" disabled>Skip</button>
      <button id="stopBtn" disabled>Stop</button>
    </div>
    <div class="status-container">
      <div id="status">Click "Start" to begin the chat.</div>
      <div class="loading" id="loading" style="display: none;">
        <div class="spinner"></div>
        <span>Searching for a stranger...</span>
      </div>
    </div>
  </div>
  <div id="banOverlay">
    <p id="banMessage"></p>
  </div>
  <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <script src="script.js"></script>
  <script>
    // Report functionality integrated here to ensure it works independently of script.js
    document.addEventListener('DOMContentLoaded', function() {
      const reportBtn = document.getElementById('reportBtn');
      let isReporting = false; // Flag to prevent multiple reports
   
      // Listen for partner-found event to show the button and set partner ID
      if (typeof socket !== 'undefined') {
        socket.on('partner-found', function(data) {
          reportBtn.style.display = 'block';
          window.partnerId = data.id; // Store partner ID for reporting
          console.log('Partner found, showing report button');
        });
        // Optionally, hide button on disconnect/skip/stop
        socket.on('partner-disconnected', function() {
          reportBtn.style.display = 'none';
          window.partnerId = null;
          isReporting = false;
        });
        socket.on('waiting', function() {
          reportBtn.style.display = 'none';
          window.partnerId = null;
          isReporting = false;
        });
        // Listen for reportHandled from server (automatic analysis result)
        socket.on('reportHandled', function(data) {
          if (!isReporting) return; // Ignore if not currently reporting
          isReporting = false;
          alert(data.message); // Show server response (nudity detected/banned, no nudity, or error)
          reportBtn.disabled = false;
          reportBtn.textContent = 'Report Porn';
        });
        // Handle banned event
        socket.on('banned', function(data) {
          document.getElementById('banMessage').textContent = data.message;
          document.getElementById('banOverlay').style.display = 'flex';
          // Disable controls
          document.getElementById('startBtn').disabled = true;
          document.getElementById('skipBtn').disabled = true;
          document.getElementById('stopBtn').disabled = true;
          document.getElementById('chatInput').disabled = true;
          document.getElementById('sendBtn').disabled = true;
          reportBtn.disabled = true;
          // Stop videos and streams
          const localVideo = document.getElementById('localVideo');
          const remoteVideo = document.getElementById('remoteVideo');
          if (localVideo.srcObject) {
            localVideo.srcObject.getTracks().forEach(track => track.stop());
            localVideo.srcObject = null;
          }
          if (remoteVideo.srcObject) {
            remoteVideo.srcObject.getTracks().forEach(track => track.stop());
            remoteVideo.srcObject = null;
          }
          // Disconnect socket if needed, but since server disconnects, it may not be necessary
        });
      }
   
      reportBtn.addEventListener('click', function() {
        if (!window.partnerId) {
          alert('No active partner to report.');
          return;
        }
        if (isReporting) {
          alert('Report already in progress.');
          return;
        }
        isReporting = true;
        reportBtn.disabled = true;
        reportBtn.textContent = 'Analyzing...';
     
        html2canvas(document.body, {
          backgroundColor: null,
          scale: 1
        }).then(canvas => {
          const dataUrl = canvas.toDataURL('image/png');
       
          // Emit to server with partner ID - server will analyze and respond
          socket.emit('reportPorn', {
            screenshot: dataUrl,
            timestamp: new Date().toISOString(),
            partnerId: window.partnerId
          });
          // No immediate alert; wait for 'reportHandled'
        }).catch(err => {
          console.error('Screenshot failed:', err);
          alert('Failed to take screenshot.');
          isReporting = false;
          reportBtn.disabled = false;
          reportBtn.textContent = 'Report Porn';
        });
      });
    });
  </script>
</body>
</html>
