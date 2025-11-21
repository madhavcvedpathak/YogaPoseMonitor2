// static/pose_detector.js

const { PoseLandmarker, FilesetResolver, DrawingUtils } = window.VisionTasks;

// --- Global State and Elements ---
let poseLandmarker = undefined;
let webcamRunning = false;
let lastVideoTime = -1;
let sessionActive = false;
let poseDataLog = []; // Temporary log for batching data to the server
const USER_ID_TOKEN = "YOUR_FIREBASE_ID_TOKEN_HERE"; // *** IMPORTANT: REPLACE with actual token after Firebase Auth ***

const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");
const enableCamButton = document.getElementById("enableCamButton");
const startSessionButton = document.getElementById("startSessionButton");
const endSessionButton = document.getElementById("endSessionButton");
const feedbackDiv = document.getElementById("feedback");
const logStatusDiv = document.getElementById("log-status");

const drawingUtils = new DrawingUtils(canvasCtx);
const LOG_INTERVAL_MS = 5000; // Log data to server every 5 seconds (5000ms)

// --- API Utility Function ---
async function apiCall(endpoint, method = 'GET', body = null) {
    logStatusDiv.innerText = `API: Sending ${endpoint}...`;
    try {
        const headers = {
            'Authorization': `Bearer ${USER_ID_TOKEN}`,
            'Content-Type': 'application/json'
        };

        const config = {
            method: method,
            headers: headers,
        };
        if (body) {
            config.body = JSON.stringify(body);
        }

        const response = await fetch(endpoint, config);
        const data = await response.json();
        
        if (data.status === 'success') {
            logStatusDiv.innerText = `API: ${data.message}`;
        } else {
            logStatusDiv.innerText = `API Error: ${data.message || 'Unknown error'}`;
        }
        return data;

    } catch (error) {
        logStatusDiv.innerText = `API Error: Could not reach server.`;
        console.error(`API Call to ${endpoint} failed:`, error);
        return { status: 'error', message: 'Network or server error' };
    }
}

// --- Session Management Handlers ---
startSessionButton.onclick = async () => {
    sessionActive = true;
    poseDataLog = []; // Clear the local log
    startSessionButton.style.display = 'none';
    endSessionButton.style.display = 'inline';
    
    // Call the protected Flask route
    const data = await apiCall('/start_session', 'POST', { user_name: "Web User" }); 
    feedbackDiv.innerText = data.message;

    // Start batch logging to the server
    setTimeout(batchLogPoseData, LOG_INTERVAL_MS);
};

endSessionButton.onclick = async () => {
    sessionActive = false;
    endSessionButton.style.display = 'none';
    
    // Call the protected Flask route
    const data = await apiCall('/end_session', 'POST'); 
    
    feedbackDiv.innerText = data.message;

    if (data.status === 'success' && data.report_path) {
        logStatusDiv.innerHTML = `Report generated! <a href="/download_report" target="_blank">Download Report</a>`;
    }
};

// --- Batch Logging Logic ---
function batchLogPoseData() {
    if (!sessionActive || poseDataLog.length === 0) {
        if (sessionActive) {
            setTimeout(batchLogPoseData, LOG_INTERVAL_MS); // Keep checking
        }
        return;
    }

    // Send the data and clear the local buffer
    const dataToSend = [...poseDataLog]; // Copy the data
    poseDataLog = []; // Clear the original array
    
    apiCall('/log_pose', 'POST', { pose_data: dataToSend })
        .then(() => {
            if (sessionActive) {
                setTimeout(batchLogPoseData, LOG_INTERVAL_MS); // Schedule next log
            }
        });
}

// --- 1. Load the Pose Landmarker Model ---
async function createPoseLandmarker() {
  feedbackDiv.innerText = "Downloading AI model...";
  // FilesetResolver helps load the necessary WASM files for the model
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
  );
  
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
      runningMode: "VIDEO",
    },
    numPoses: 1, 
  });

  feedbackDiv.innerText = "Model loaded. Click START to begin.";
  enableCamButton.onclick = enableCam;
}

// --- 2. Enable Camera and Start Detection ---
function enableCam() {
  if (!poseLandmarker) return;

  if (webcamRunning) {
    webcamRunning = false;
    enableCamButton.innerText = "Start Pose Detection";
    video.srcObject.getTracks().forEach(track => track.stop());
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    feedbackDiv.innerText = "Detection Stopped.";
    startSessionButton.style.display = 'none';
    endSessionButton.style.display = 'none';
    return;
  }

  const constraints = { video: { facingMode: "user" } };

  navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", predictWebcam);
    webcamRunning = true;
    enableCamButton.innerText = "Stop Detection";
    feedbackDiv.innerText = "Camera enabled. Starting tracking...";
    startSessionButton.style.display = 'inline';
    endSessionButton.style.display = 'none';
  }).catch(error => {
      feedbackDiv.innerText = `Error accessing camera: ${error.name}`;
      console.error("Camera access error:", error);
  });
}

// --- 3. The Continuous Detection Loop ---
function predictWebcam() {
  canvasElement.height = video.videoHeight;
  canvasElement.width = video.videoWidth;

  let startTimeMs = performance.now();
  if (lastVideoTime !== video.currentTime) {
    lastVideoTime = video.currentTime;
    
    poseLandmarker.detectForVideo(video, startTimeMs, (result) => {
      canvasCtx.save();
      canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

      if (result.landmarks && result.landmarks.length > 0) {
        
        // A. Draw the Skeleton (Visualization)
        for (const landmarks of result.landmarks) {
          drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {color: '#B53471', lineWidth: 4});
          drawingUtils.drawLandmarks(landmarks, {color: '#FFF', lineWidth: 2, radius: 4});
        }
        
        // B. Custom Pose Analysis (Your application logic)
        const landmarks = result.landmarks[0]; 
        
        // --- POSE ANALYSIS & LOGGING ---
        const poseName = "Tadasana"; // Replace with your actual pose detection logic
        const confidenceScore = 0.95; // Replace with confidence from your analysis

        if (sessionActive) {
            // Log the pose data required by the Python backend's pose_log array
            poseDataLog.push({
                timestamp: Date.now() / 1000, // Unix timestamp in seconds
                pose: poseName,
                confidence: confidenceScore,
                // Add any other metrics like 'angle_data' here
            });
        }
        // --- END POSE ANALYSIS & LOGGING ---
        
        feedbackDiv.style.color = '#2ecc71';
        feedbackDiv.innerText = `Tracking Active. Current Pose: ${poseName}`;
      } else {
        feedbackDiv.style.color = '#e74c3c';
        feedbackDiv.innerText = "No person detected. Please stand fully in view.";
      }
      
      canvasCtx.restore();
    });
  }

  if (webcamRunning) {
    window.requestAnimationFrame(predictWebcam);
  }
}

// Start the process
createPoseLandmarker();