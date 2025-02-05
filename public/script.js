document.addEventListener('DOMContentLoaded', () => {
  // Elementen voor de multi-step
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const nextButton = document.getElementById('nextButton');
  const generalForm = document.getElementById('generalForm');
  const generalInfoInput = document.getElementById('generalInfo');

  // Elementen voor de audio stap
  const form = document.getElementById('uploadForm');
  const progress = document.getElementById('progress');
  const summaryContent = document.getElementById('summary-content');
  const error = document.getElementById('error');
  const audioInput = document.getElementById('audioFile');
  const contextInput = document.getElementById('contextFile');
  const recordButton = document.getElementById('recordButton');
  const recordingStatus = document.getElementById('recordingStatus');
  const recordingTime = document.getElementById('recordingTime');
  const downloadLink = document.getElementById('downloadLink');

  let mediaRecorder;
  let recordedChunks = [];
  let startTime;
  let timerInterval;
  let isRecording = false;


  // Functie voor opname-timer
  function updateRecordingTime() {
    const currentTime = new Date();
    const timeDiff = new Date(currentTime - startTime);
    const minutes = timeDiff.getUTCMinutes().toString().padStart(2, '0');
    const seconds = timeDiff.getUTCSeconds().toString().padStart(2, '0');
    recordingTime.textContent = `${minutes}:${seconds}`;
  }

  // Initialiseer opnamefunctionaliteit
  async function initializeRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
        const file = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });

        // Simuleer invullen van het file-input element
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        audioInput.files = dataTransfer.files;

        // Reset opname status
        recordedChunks = [];
        recordingStatus.style.display = 'none';
        clearInterval(timerInterval);

      };

    } catch (err) {
      console.error('Error accessing microphone:', err);
      error.textContent = 'Kon geen toegang krijgen tot de microfoon. Controleer of je toestemming hebt gegeven.';
      error.style.display = 'block';
    }
  }

  // Klik-handler voor de record-knop
  recordButton.addEventListener('click', () => {
    if (!isRecording) {
      if (!mediaRecorder) {
        initializeRecording().then(() => {
          startRecording();
        });
      } else {
        startRecording();
      }
    } else {
      stopRecording();
    }
  });

  function startRecording() {
    recordedChunks = [];
    mediaRecorder.start();
    isRecording = true;
    recordButton.innerHTML = '<span>Stop Opname</span>';
    recordButton.classList.add('recording');
    recordingStatus.style.display = 'block';
    startTime = new Date();
    timerInterval = setInterval(updateRecordingTime, 1000);
  }

  function stopRecording() {
    mediaRecorder.stop();
    isRecording = false;
    recordButton.innerHTML = '<span>Start Opname</span>';
    recordButton.classList.remove('recording');
    clearInterval(timerInterval);
  }

  // Navigatie: Stap 1 -> Stap 2
  nextButton.addEventListener('click', () => {
    if (!generalForm.checkValidity()) {
      generalForm.reportValidity();
      return;
    }
    // Verzamel algemene gegevens
    const generalInfo = {
      meetingDate: document.getElementById('meetingDate').value,
      meetingLocation: document.getElementById('meetingLocation').value,
      participants: document.getElementById('participants').value,
      absentees: document.getElementById('absentees').value,
      meetingPurpose: document.getElementById('meetingPurpose').value,
      confidentiality: document.getElementById('confidentiality').value,
    };
    generalInfoInput.value = JSON.stringify(generalInfo);

    // Fade out stap 1 en fade in stap 2
    step1.classList.add('hidden');
    setTimeout(() => {
      step1.style.display = 'none';
      step2.style.display = 'block';
      step2.classList.remove('hidden');
      step2.classList.add('visible');
    }, 500);
  });

  // Formulierverwerking: Stap 2 (audio upload) -> Stap 3 (samenvatting)
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    try {
      const audioFile = audioInput.files[0];
      const contextFile = contextInput.files[0];

      if (!audioFile) {
        throw new Error('Selecteer een audiobestand of maak een opname');
      }

      const formData = new FormData();
      formData.append('audio', audioFile);
      formData.append('instruction', document.getElementById('instruction').value);
      formData.append('generalInfo', generalInfoInput.value);

      if (contextFile) {
        formData.append('context', contextFile);
      }

      progress.style.display = 'block';
      error.style.display = 'none';

      const response = await fetch('/upload', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Serverfout: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      summaryContent.innerHTML = result.summary;

      // Na succesvolle verwerking: Fade out stap 2 en fade in stap 3
      step2.classList.add('hidden');
      setTimeout(() => {
        step2.style.display = 'none';
        step3.style.display = 'block';
        step3.classList.remove('hidden');
        step3.classList.add('visible');
      }, 500);

    } catch (err) {
      console.error('Upload error:', err);
      error.textContent = err.message;
      error.style.display = 'block';
    } finally {
      progress.style.display = 'none';
    }
  });

  // Functionaliteit voor de kopieer-knop
  const copyButton = document.getElementById('copyButton');
  copyButton.addEventListener('click', async () => {
    try {
      const htmlContent = summaryContent.innerHTML;
      const clipboardItem = new ClipboardItem({
        'text/html': new Blob([htmlContent], { type: 'text/html' }),
        'text/plain': new Blob([summaryContent.innerText], { type: 'text/plain' })
      });
      await navigator.clipboard.write([clipboardItem]);

      const originalText = copyButton.innerHTML;
      copyButton.innerHTML = '<span>Gekopieerd!</span>';
      setTimeout(() => {
        copyButton.innerHTML = originalText;
      }, 2000);
    } catch (err) {
      console.error('Copy failed:', err);
      error.textContent = 'Kopiëren mislukt. Probeer opnieuw.';
      error.style.display = 'block';
    }
  });
});
