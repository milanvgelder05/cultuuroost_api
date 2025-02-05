import { useState, useRef } from "react";

const AudioRecorder = () => {
  const [recording, setRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const mediaRecorderRef = useRef(null);
  const audioChunks = useRef([]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorderRef.current = new MediaRecorder(stream);
    
    mediaRecorderRef.current.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.current.push(event.data);
      }
    };

    mediaRecorderRef.current.onstop = async () => {
      const audioBlob = new Blob(audioChunks.current, { type: "audio/webm" });
      setAudioBlob(audioBlob);
      await uploadAudio(audioBlob);
      audioChunks.current = [];
    };

    mediaRecorderRef.current.start();
    setRecording(true);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setRecording(false);
    }
  };

  const uploadAudio = async (audioBlob) => {
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");

    const response = await fetch("http://localhost:5000/upload", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();
    alert(`Summary: ${data.summary}`);
  };

  return (
    <div>
      <button onClick={recording ? stopRecording : startRecording}>
        {recording ? "Stop Recording" : "Start Recording"}
      </button>
    </div>
  );
};

export default AudioRecorder;
