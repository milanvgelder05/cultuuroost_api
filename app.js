const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)){
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});



// Configure file filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/mp4'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only MP3, WAV, and MP4 audio files are allowed.'));
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function transcribeAudio(audioFilePath) {
    const audioFile = fs.createReadStream(audioFilePath);
    const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: audioFile,
    });
    return transcription.text;
}

async function generateSummary(transcriptionText) {
    const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
            {
                role: 'system',
                content: `"Identificeer de agenda en context:
- Begin de samenvatting met een overzicht van de agenda of de onderwerpen die besproken zijn. Dit omvat:
  - Datum en tijd van het overleg.
  - Aanwezige deelnemers (indien vermeld).
  - Hoofddoel(en) van de vergadering.

Structuur van de samenvatting:
Gebruik de volgende secties om de samenvatting op te bouwen:

- Agenda:
  - Vermeld de geplande onderwerpen zoals benoemd aan het begin van de vergadering.
  - Noteer eventuele wijzigingen of toevoegingen aan de agenda tijdens de vergadering.

- Besproken onderwerpen:
  - Vat per onderwerp kort samen wat besproken is. Gebruik duidelijke kopjes voor elk onderwerp.
  - Geef per onderwerp kerninzichten, meningen, of beslissingen weer.

- Actiepunten:
  - Noteer concrete actiepunten die uit de vergadering voortkomen.
  - Voor elk actiepunt, geef aan:
    - Wat er moet gebeuren.
    - Wie verantwoordelijk is.
    - Wanneer de actie afgerond moet zijn (indien vermeld).

- Besluiten:
  - Noteer belangrijke besluiten die tijdens het overleg genomen zijn, gescheiden van de actiepunten.

- Overige opmerkingen:
  - Vermeld belangrijke discussiepunten waaruit geen concrete besluiten of acties zijn voortgekomen.
  - Noteer eventuele opmerkingen voor de volgende vergadering.

Taalgebruik en stijl:
- Gebruik duidelijke, beknopte en neutrale taal.
- Schrijf in de derde persoon en vermijd onnodige details.
- Focus op relevantie: samenvatten betekent het weglaten van irrelevante informatie.

Format:
- Gebruik opsommingen voor actiepunten, besluiten en andere concrete lijstjes.
- Gebruik vetgedrukte tekst voor namen of belangrijke termen (indien nodig)."
`,
            },
            {
                role: 'user',
                content: `maak een samenvatting in het nederlands ${transcriptionText} en zet het gestructureerd onder elkaar met het gebruik van /n`,
            },
        ],
    });
    return completion.choices[0].message.content;
}

// Serve the HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle file upload and processing
app.post('/upload', upload.single('audio'), async (req, res) => {
    // Set proper content type header
    res.setHeader('Content-Type', 'application/json');
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file uploaded' });
        }
        
        const audioFilePath = req.file.path;
        
        // Transcribe audio
        console.log('Transcribing audio...');
        const transcriptionText = await transcribeAudio(audioFilePath);
        console.log('Transcription completed successfully.');
        
        // Generate summary
        console.log('Generating summary...');
        const summaryText = await generateSummary(transcriptionText);
        
        // Save summary
        const outputFilePath = path.join(__dirname, 'uploads', `summary-${Date.now()}.txt`);
        fs.writeFileSync(outputFilePath, summaryText);
        
        // Send JSON response
        res.json({
            message: 'Processing completed successfully',
            summary: summaryText,
            summaryPath: outputFilePath
        });
    } catch (error) {
        console.error('Error:', error);
        // Send error as JSON
        res.status(500).json({
            error: 'An error occurred during processing',
            details: error.message
        });
    } finally {
        // Clean up uploaded file if needed
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({
        error: 'Server error',
        details: err.message
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});