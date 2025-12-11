/**
 * Single-File PDF Compression Server (Express.js)
 * * Dependencies: npm install express cors
 * System Requirement: Ghostscript (gs) must be installed on the system.
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { pipeline } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = "https://tdqewqarcvdunwuxgios.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkcWV3cWFyY3ZkdW53dXhnaW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0ODc4NDcsImV4cCI6MjA4MTA2Mzg0N30.RSMghTLwda7kLidTohBFLqE7qCQoHs3S6l88ewUidRw";
const BUCKET_NAME = "pdf-files";

// Configure paths for temp files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Promisify pipeline for clean async/await stream handling
const streamPipeline = promisify(pipeline);

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json()); // Parse JSON bodies

// --- Helper: Download File Stream ---
// Uses native https to avoid extra dependencies like axios
const downloadFile = (url, destPath) => {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        
        // Parse URL to ensure we are using https
        if (!url.startsWith('https')) {
            return reject(new Error('Only HTTPS URLs are supported'));
        }

        const request = https.get(url, {
            headers: {
                // Although public, we provide auth headers just in case of RLS policies
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        }, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download file. Status Code: ${response.statusCode}`));
            }

            // Pipe response to file
            pipeline(response, file, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        request.on('error', (err) => {
            fs.unlink(destPath, () => {}); // Delete partial file on error
            reject(err);
        });
    });
};

// --- Helper: Compress PDF using Ghostscript ---
const compressPdf = (inputPath, outputPath) => {
    return new Promise((resolve, reject) => {
        // Ghostscript command for ebook quality (approx 150 dpi) - good balance of size/quality
        // -dPDFSETTINGS=/screen (72 dpi, smallest)
        // -dPDFSETTINGS=/ebook (150 dpi, medium - BEST FOR GENERAL USE)
        // -dPDFSETTINGS=/prepress (300 dpi, high quality)
        
        const command = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error("Ghostscript error:", stderr);
                return reject(error);
            }
            resolve(outputPath);
        });
    });
};

// --- Helper: Cleanup Files ---
const cleanupFiles = (paths) => {
    paths.forEach(p => {
        if (fs.existsSync(p)) {
            fs.unlink(p, (err) => {
                if (err) console.error(`Error deleting temp file ${p}:`, err);
            });
        }
    });
};

// --- Routes ---

// 1. Health Check
app.get('/test', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        message: 'PDF Compression Server is running',
        timestamp: new Date().toISOString()
    });
});

// 2. Compress Endpoint
app.post('/compress', async (req, res) => {
    const { pdfUrl } = req.body;

    // Validation
    if (!pdfUrl) {
        return res.status(400).json({ error: 'Missing "pdfUrl" in request body.' });
    }

    // Security: Ensure URL belongs to Supabase (prevent arbitrary SSRF)
    if (!pdfUrl.includes('supabase.co')) {
        return res.status(400).json({ error: 'Invalid URL source. Only Supabase URLs allowed.' });
    }

    const requestId = crypto.randomUUID();
    const inputFilePath = path.join(TEMP_DIR, `input_${requestId}.pdf`);
    const outputFilePath = path.join(TEMP_DIR, `output_${requestId}.pdf`);

    try {
        console.log(`[${requestId}] Starting download: ${pdfUrl}`);
        
        // 1. Download (Streamed to disk to handle large files)
        await downloadFile(pdfUrl, inputFilePath);
        
        console.log(`[${requestId}] Download complete. Starting compression...`);

        // 2. Compress
        await compressPdf(inputFilePath, outputFilePath);

        console.log(`[${requestId}] Compression complete. Sending file...`);

        // 3. Return File
        // We use res.download which handles streams internally
        res.download(outputFilePath, 'compressed-file.pdf', (err) => {
            if (err) {
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error sending file.' });
                }
            }
            // 4. Cleanup after response is finished
            cleanupFiles([inputFilePath, outputFilePath]);
        });

    } catch (error) {
        console.error(`[${requestId}] Error:`, error.message);
        
        // Cleanup on error
        cleanupFiles([inputFilePath, outputFilePath]);

        if (error.message.includes('Command failed')) {
            return res.status(500).json({ 
                error: 'Compression failed. Please ensure Ghostscript is installed on the server.' 
            });
        }

        res.status(500).json({ 
            error: 'Internal Server Error', 
            details: error.message 
        });
    }
});

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`--- PDF Compression Server ---`);
    console.log(`Running on port: ${PORT}`);
    console.log(`Supabase URL: ${SUPABASE_URL}`);
    console.log(`Temp Directory: ${TEMP_DIR}`);
    console.log(`------------------------------`);
});
