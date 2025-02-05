/**************************************
 * app.js
 **************************************/

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const mammoth = require('mammoth');
const PDFParser = require('pdf-parse');
const ngrok = require('ngrok'); // (Currently not used in serverless mode)
const pLimitModule = import('p-limit')

// Dynamic p-limit function
async function getLimitFunction() {
  const { default: limit } = await pLimitModule;
  return limit;
}

// Simple logger utility
const logger = {
  info: (message) => console.log(`[INFO] ${message}`),
  warn: (message) => console.warn(`[WARN] ${message}`),
  error: (message) => console.error(`[ERROR] ${message}`)
};

const app = express();

// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));
logger.info('Static files middleware configured');

// Configure storage and filename handling for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    try {
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    } catch (err) {
      logger.error(`Upload directory error: ${err.message}`);
      cb(new Error('Could not create upload directory'));
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    const filename = `${timestamp}-${sanitizedName}`;
    cb(null, filename);
  }
});

// File filter to accept only valid audio and context files
const fileFilter = (req, file, cb) => {
  const allowedAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/webm'];
  const allowedContextTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  if (file.fieldname === 'audio' && allowedAudioTypes.includes(file.mimetype)) {
    logger.info(`Audio file accepted: ${file.originalname}`);
    return cb(null, true);
  } else if (file.fieldname === 'context' && allowedContextTypes.includes(file.mimetype)) {
    logger.info(`Context file accepted: ${file.originalname}`);
    return cb(null, true);
  } else {
    logger.warn(`Rejected file: ${file.originalname} (Invalid type)`);
    return cb(new Error('Invalid file type'), false);
  }
};

// Reads a context file (DOCX, PDF, or text) and returns its content as a string.
async function readContextFile(contextFilePath) {
  try {
    const ext = path.extname(contextFilePath).toLowerCase();
    if (ext === '.docx') {
      logger.info('Processing Word document (docx)');
      const result = await mammoth.extractRawText({ path: contextFilePath });
      return result.value.trim();
    } else if (ext === '.pdf') {
      logger.info('Processing PDF file');
      const pdfBuffer = fs.readFileSync(contextFilePath);
      const result = await PDFParser(pdfBuffer);
      return result.text.trim();
    } else {
      logger.info('Processing as text file');
      return fs.readFileSync(contextFilePath, 'utf8').trim();
    }
  } catch (error) {
    logger.error(`Context file reading error: ${error.message}`);
    return `Error reading context file: ${error.message}`;
  }
}

// Convert an audio file to MP3 format using ffmpeg.
function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const inputSize = fs.statSync(inputPath).size;
      logger.info(`File size before MP3 conversion: ${inputSize} bytes (${path.basename(inputPath)})`);
    } catch (error) {
      logger.error(`Could not read file size for ${path.basename(inputPath)}: ${error.message}`);
    }

    logger.info(`Converting ${path.basename(inputPath)} to MP3 format as ${path.basename(outputPath)}`);

    ffmpeg(inputPath)
      .toFormat('mp3')
      .on('end', () => {
        logger.info(`Audio conversion completed: ${path.basename(outputPath)}`);
        try {
          const outputSize = fs.statSync(outputPath).size;
          logger.info(`File size after MP3 conversion: ${outputSize} bytes (${path.basename(outputPath)})`);
        } catch (error) {
          logger.error(`Could not read file size for ${path.basename(outputPath)}: ${error.message}`);
        }
        resolve(outputPath);
      })
      .on('error', (err) => {
        logger.error(`Conversion error: ${err.message}`);
        reject(err);
      })
      .save(outputPath);
  });
}

// Creates a 5-minute chunk from the input file.
function createChunk(inputFile, outputFile, startTime, duration) {
  return new Promise((resolve, reject) => {
    logger.info(`Creating chunk [start=${startTime}s, duration=${duration}s] => ${path.basename(outputFile)}`);
    ffmpeg(inputFile)
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .outputOptions(['-ac 1', '-ar 16000'])
      .seekInput(startTime)
      .duration(duration)
      .on('end', () => {
        logger.info(`Chunk file created: ${path.basename(outputFile)}`);
        resolve();
      })
      .on('error', (err) => {
        logger.error(`Error creating chunk: ${err.message}`);
        reject(err);
      })
      .save(outputFile);
  });
}

// Transcribes a single audio chunk using OpenAI's Whisper model.
async function transcribeSingleChunk(chunkPath) {
  logger.info(`Transcribing chunk: ${path.basename(chunkPath)}`);
  try {
    const audioFileStream = fs.createReadStream(chunkPath);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: audioFileStream,
    });
    return transcription.text;
  } catch (error) {
    logger.error(`Transcription error for ${path.basename(chunkPath)}: ${error.message}`);
    throw error;
  }
}

// Slices the audio file into 5-minute chunks and transcribes them in parallel.
async function chunkAndTranscribeAudioParallel(filePath) {
  logger.info(`Starting audio transcription in parallel chunks for: ${path.basename(filePath)}`);

  // Retrieve total duration of the audio file
  const metadata = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
  const totalDuration = Math.floor(metadata.format.duration);
  logger.info(`Total duration: ${totalDuration}s`);

  const chunkDurationSec = 300; // 5 minutes
  const numChunks = Math.ceil(totalDuration / chunkDurationSec);
  const chunks = [];
  for (let i = 0; i < numChunks; i++) {
    const startTime = i * chunkDurationSec;
    const thisChunkDuration = Math.min(chunkDurationSec, totalDuration - startTime);
    chunks.push({ chunkIndex: i, startTime, duration: thisChunkDuration });
  }

  // Limit concurrent transcription tasks (max 10 at a time)
  const createLimit = await getLimitFunction();
  const limit = createLimit(10);
  const partialTranscripts = await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        const chunkFilePath = `${filePath}_chunk_${chunk.chunkIndex}.mp3`;
        await createChunk(filePath, chunkFilePath, chunk.startTime, chunk.duration);
        const transcript = await transcribeSingleChunk(chunkFilePath);
        try {
          await fs.promises.unlink(chunkFilePath);
          logger.info(`Deleted chunk file: ${path.basename(chunkFilePath)}`);
        } catch (err) {
          logger.error(`Error deleting chunk file ${path.basename(chunkFilePath)}: ${err.message}`);
        }
        return { index: chunk.chunkIndex, text: transcript };
      })
    )
  );

  // Sort transcripts by chunk index to preserve order and return the concatenated result.
  partialTranscripts.sort((a, b) => a.index - b.index);
  return partialTranscripts.map((pt) => pt.text).join('\n').trim();
}

// Generates a summary using OpenAI Chat Completions API.
async function generateSummary(transcriptionText, instruction = '', contextFilePath = null, generalInfo = null) {
  let systemPrompt = '';
  try {
    systemPrompt = fs.readFileSync(path.join(__dirname, 'systemPrompt.txt'), 'utf8');
  } catch (error) {
    logger.error(`Error reading system prompt: ${error.message}`);
    throw new Error('System prompt not found');
  }

  logger.info('Preparing to generate summary from transcribed text');

  try {
    // Read additional context if provided
    let contextContent = '';
    if (contextFilePath) {
      logger.info(`Reading additional context file: ${path.basename(contextFilePath)}`);
      contextContent = await readContextFile(contextFilePath);
    }

    // Process general meeting information if provided
    let generalInfoContent = '';
    if (generalInfo) {
      try {
        const generalData = JSON.parse(generalInfo);
        generalInfoContent =
          `Algemene Gegevens:\n` +
          `Datum: ${generalData.meetingDate}\n` +
          `Locatie: ${generalData.meetingLocation}\n` +
          `Deelnemers: ${generalData.participants}\n` +
          `Afwezigen: ${generalData.absentees}\n` +
          `Doel van het gesprek: ${generalData.meetingPurpose}\n` +
          `Vertrouwelijkheid: ${generalData.confidentiality}\n`;
      } catch (err) {
        logger.warn('Error parsing generalInfo; using raw value');
        generalInfoContent = generalInfo;
      }
    }

    // Build the messages for the Chat API.
    const messages = [
      {
        role: 'system',
        content: `${systemPrompt}\nGebruik de volgende algemene gegevens: ${generalInfoContent}\nGebruik deze context (indien aanwezig): ${contextContent}. Genereer in HTML zonder onnodige tags bovenaan(gebruik HTML dus alleen voor de kopjes etc.) en zonder '''html bovenaan`
      },
      {
        role: 'user',
        content: `Hier is de transcriptie. Maak een verslag:\n${transcriptionText}`
      }
    ];

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', // Replace with your desired model if needed.
      messages: messages
    });

    logger.info('Summary generation completed successfully');
    return completion.choices[0].message.content;
  } catch (error) {
    logger.error(`Summary generation error: ${error.message}`);
    throw new Error('Failed to generate summary');
  }
}

// Set up Multer for handling file uploads
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
    files: 2 // Maximum 2 files: audio and context
  }
});

// Serve the index page
app.get('/', (req, res) => {
  logger.info('Serving index.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle file uploads and processing
app.post(
  '/upload',
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'context', maxCount: 1 }
  ]),
  async (req, res) => {
    logger.info('Received upload request');
    res.setHeader('Content-Type', 'application/json');

    try {
      if (!req.files || !req.files.audio) {
        logger.warn('No audio file uploaded');
        return res.status(400).json({ error: 'No audio file uploaded' });
      }

      const audioFilePath = req.files.audio[0].path;
      const contextFile = req.files.context ? req.files.context[0] : null;
      const instruction = req.body.instruction;
      const generalInfo = req.body.generalInfo; // General meeting details

      if (!instruction) {
        logger.warn('Missing instruction in the request body');
        return res.status(400).json({ error: 'Instruction is required' });
      }

      // Convert audio to MP3 if necessary (e.g. for m4a or webm)
      let finalAudioPath = audioFilePath;
      if (req.files.audio[0].mimetype === 'audio/x-m4a') {
        const mp3Path = audioFilePath.replace(/\.m4a$/, '.mp3');
        finalAudioPath = await convertToMp3(audioFilePath, mp3Path);
      }
      if (req.files.audio[0].mimetype === 'audio/webm') {
        const mp3Path = audioFilePath.replace(/\.webm$/, '.mp3');
        finalAudioPath = await convertToMp3(audioFilePath, mp3Path);
      }

      // Transcribe the audio (in parallel chunks)
      const transcriptionText = await chunkAndTranscribeAudioParallel(finalAudioPath);

      // Generate summary using the transcription, instruction, context file, and general info.
      const summaryText = await generateSummary(
        transcriptionText,
        instruction,
        contextFile ? contextFile.path : null,
        generalInfo
      );

      // Save summary to a file
      const outputFilePath = path.join(__dirname, 'uploads', `summary-${Date.now()}.txt`);
      fs.writeFileSync(outputFilePath, summaryText);
      logger.info(`Summary file created: ${path.basename(outputFilePath)}`);

      res.json({
        message: 'Processing completed successfully',
        summary: summaryText,
        summaryPath: outputFilePath,
        downloadUrl: `/uploads/${path.basename(finalAudioPath)}`
      });
    } catch (error) {
      logger.error(`Processing error: ${error.message}`);
      res.status(500).json({
        error: 'An error occurred during processing',
        details: error.message
      });
    } finally {
      // Cleanup: delete uploaded and temporary files asynchronously.
      const cleanupFile = async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
            logger.info(`File deleted: ${path.basename(filePath)}`);
          } catch (err) {
            logger.error(`File deletion error for ${path.basename(filePath)}: ${err.message}`);
          }
        }
      };

      // Delete original audio file
      cleanupFile(req.files && req.files.audio ? req.files.audio[0].path : null);
      // Delete context file if uploaded
      cleanupFile(req.files && req.files.context ? req.files.context[0].path : null);
      // Delete converted MP3 file if applicable
      if (
        req.files &&
        req.files.audio &&
        (req.files.audio[0].mimetype === 'audio/x-m4a' ||
          req.files.audio[0].mimetype === 'audio/webm')
      ) {
        const mp3Path = req.files.audio[0].path.replace(/\.(m4a|webm)$/, '.mp3');
        cleanupFile(mp3Path);
      }
    }
  }
);

// Global error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: 'File upload error',
      details: err.message
    });
  }
  res.status(500).json({
    error: 'Server error',
    details: err.message || 'An unexpected error occurred'
  });
});

// NOTE: We have removed the app.listen() call since Netlify will invoke the exported app as a serverless function.
module.exports = serverless(app);
