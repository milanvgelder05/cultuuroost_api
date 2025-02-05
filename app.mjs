/**************************************
 * app.js (ESM)
 **************************************/

import 'dotenv/config';                      // Equivalent to require('dotenv').config();
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import serverless from 'serverless-http';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { OpenAI } from 'openai';             // v4.x import
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import ngrok from 'ngrok';                  // (Currently not used in serverless mode)
import pLimit from 'p-limit';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// We need __dirname in ESM:
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configure ffmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

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

// Multer storage for serverless environment -> /tmp/uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join('/tmp', 'uploads');
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

// File filter for audio/context
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

// Reads a context file (DOCX, PDF, or text) and returns its content.
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
      const result = await pdfParse(pdfBuffer);
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

// Convert audio to MP3 if needed
function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const inputSize = fs.statSync(inputPath).size;
      logger.info(
        `File size before MP3 conversion: ${inputSize} bytes (${path.basename(inputPath)})`
      );
    } catch (error) {
      logger.error(
        `Could not read file size for ${path.basename(inputPath)}: ${error.message}`
      );
    }

    logger.info(
      `Converting ${path.basename(inputPath)} to MP3 format as ${path.basename(outputPath)}`
    );

    ffmpeg(inputPath)
      .toFormat('mp3')
      .on('end', () => {
        logger.info(`Audio conversion completed: ${path.basename(outputPath)}`);
        try {
          const outputSize = fs.statSync(outputPath).size;
          logger.info(
            `File size after MP3 conversion: ${outputSize} bytes (${path.basename(outputPath)})`
          );
        } catch (error) {
          logger.error(
            `Could not read file size for ${path.basename(outputPath)}: ${error.message}`
          );
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

// Creates a 5-minute chunk from the input file
function createChunk(inputFile, outputFile, startTime, duration) {
  return new Promise((resolve, reject) => {
    logger.info(
      `Creating chunk [start=${startTime}s, duration=${duration}s] => ${path.basename(outputFile)}`
    );
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

// Transcribes a single audio chunk via OpenAI Whisper
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

// Slices the audio file into 5-minute chunks and transcribes them in parallel
async function chunkAndTranscribeAudioParallel(filePath) {
  logger.info(
    `Starting audio transcription in parallel chunks for: ${path.basename(filePath)}`
  );

  // Retrieve total duration
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

  // Limit concurrency to 10
  const limit = pLimit(10);
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
          logger.error(
            `Error deleting chunk file ${path.basename(chunkFilePath)}: ${err.message}`
          );
        }
        return { index: chunk.chunkIndex, text: transcript };
      })
    )
  );

  // Sort transcripts by chunk index, concatenate
  partialTranscripts.sort((a, b) => a.index - b.index);
  return partialTranscripts.map((pt) => pt.text).join('\n').trim();
}

// Generates a summary from transcribed text
async function generateSummary(
  transcriptionText,
  instruction = '',
  contextFilePath = null,
  generalInfo = null
) {
  let systemPrompt = '';
  try {
    systemPrompt = fs.readFileSync(path.join(__dirname, 'systemPrompt.txt'), 'utf8');
  } catch (error) {
    logger.error(`Error reading system prompt: ${error.message}`);
    throw new Error('System prompt not found');
  }

  logger.info('Preparing to generate summary from transcribed text');

  try {
    // Read context if provided
    let contextContent = '';
    if (contextFilePath) {
      logger.info(`Reading additional context file: ${path.basename(contextFilePath)}`);
      contextContent = await readContextFile(contextFilePath);
    }

    // Process general meeting info if provided
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

    // Build system/user messages
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

    // Call OpenAI Chat
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      // Keep 'gpt-4o' exactly as requested
      model: 'gpt-4o',
      messages: messages
    });

    logger.info('Summary generation completed successfully');
    return completion.choices[0].message.content;
  } catch (error) {
    logger.error(`Summary generation error: ${error.message}`);
    throw new Error('Failed to generate summary');
  }
}

// Multer config
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
    files: 2 // 1 audio + 1 context
  }
});

// Serve index
app.get('/', (req, res) => {
  logger.info('Serving index.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload + Process route
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
      const generalInfo = req.body.generalInfo;

      if (!instruction) {
        logger.warn('Missing instruction in the request body');
        return res.status(400).json({ error: 'Instruction is required' });
      }

      // Convert audio to MP3 if .m4a or .webm
      let finalAudioPath = audioFilePath;
      if (req.files.audio[0].mimetype === 'audio/x-m4a') {
        const mp3Path = audioFilePath.replace(/\.m4a$/, '.mp3');
        finalAudioPath = await convertToMp3(audioFilePath, mp3Path);
      }
      if (req.files.audio[0].mimetype === 'audio/webm') {
        const mp3Path = audioFilePath.replace(/\.webm$/, '.mp3');
        finalAudioPath = await convertToMp3(audioFilePath, mp3Path);
      }

      // Transcribe in parallel
      const transcriptionText = await chunkAndTranscribeAudioParallel(finalAudioPath);

      // Summarize
      const summaryText = await generateSummary(
        transcriptionText,
        instruction,
        contextFile ? contextFile.path : null,
        generalInfo
      );

      // Save summary to /tmp (ephemeral storage)
      const outputFilePath = path.join('/tmp', `summary-${Date.now()}.txt`);
      fs.writeFileSync(outputFilePath, summaryText);
      logger.info(`Summary file created: ${path.basename(outputFilePath)}`);

      // Send JSON response
      res.json({
        message: 'Processing completed successfully',
        summary: summaryText,
        summaryPath: outputFilePath
      });
    } catch (error) {
      logger.error(`Processing error: ${error.message}`);
      res.status(500).json({
        error: 'An error occurred during processing',
        details: error.message
      });
    } finally {
      // Cleanup uploaded files
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

      // Remove original audio file
      cleanupFile(req.files && req.files.audio ? req.files.audio[0].path : null);
      // Remove context file if present
      cleanupFile(req.files && req.files.context ? req.files.context[0].path : null);

      // Remove any auto-converted MP3 if we had an M4A or WebM
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

// Global error handler
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

// Export for serverless: ESM style
export const handler = serverless(app);
