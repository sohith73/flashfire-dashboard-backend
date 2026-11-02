import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Configure Cloudflare R2 Client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true, // Required for R2 - use path-style URLs instead of virtual-hosted-style
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'flashfire-storage';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

/**
 * Upload file to Cloudflare R2
 * @param {Buffer} fileBuffer - The file buffer to upload
 * @param {Object} options - Upload options
 * @param {string} options.folder - Folder path within bucket
 * @param {string} options.filename - Original filename
 * @param {string} options.contentType - MIME type of the file
 * @param {string} options.clientName - Client name for folder organization
 * @param {string} options.fileType - Type of file (attachments, docs, etc.)
 * @returns {Promise<Object>} Upload result with URL and metadata
 */
export async function uploadToR2(fileBuffer, options = {}) {
  try {
    const {
      folder = 'flashfirejobs',
      filename = 'file',
      contentType = 'application/octet-stream',
      clientName = null,
      fileType = 'attachments',
    } = options;

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Create client-based folder structure: folder/email/fileType
    // Example: flashfirejobs/john_email_com/resume or flashfirejobs/john_email_com/attachments
    let finalFolder = folder;
    if (clientName) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9._-]/g, '_');
      finalFolder = `${folder}/${sanitizedClientName}/${fileType}`;
    } else {
      // If no client name, just use folder/fileType
      finalFolder = `${folder}/${fileType}`;
    }
    
    const key = `${finalFolder}/${timestamp}_${randomString}_${sanitizedFilename}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
      Metadata: {
        originalName: filename,
        uploadedAt: new Date().toISOString(),
      },
    });

    await r2Client.send(command);

    // Construct public URL
    let url;
    if (PUBLIC_URL) {
      // Remove trailing slash from PUBLIC_URL and leading slash from key if present
      const baseUrl = PUBLIC_URL.replace(/\/$/, '');
      const cleanKey = key.replace(/^\//, '');
      url = `${baseUrl}/${cleanKey}`;
    } else {
      url = `https://${BUCKET_NAME}.r2.cloudflarestorage.com/${key}`;
    }

    console.log('R2 Upload Success:', {
      url,
      key,
      folder: finalFolder,
      contentType,
      size: fileBuffer.length,
    });

    return {
      success: true,
      url,
      key,
      bucket: BUCKET_NAME,
      size: fileBuffer.length,
      contentType,
      storage: 'r2',
    };
  } catch (error) {
    console.error('R2 upload error:', error);
    return {
      success: false,
      error: error.message,
      storage: 'r2',
    };
  }
}

/**
 * Delete file from Cloudflare R2
 * @param {string} key - The file key/path in R2
 * @returns {Promise<Object>} Delete result
 */
export async function deleteFromR2(key) {
  try {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    await r2Client.send(command);

    return {
      success: true,
      key,
      storage: 'r2',
    };
  } catch (error) {
    console.error('R2 delete error:', error);
    return {
      success: false,
      error: error.message,
      storage: 'r2',
    };
  }
}

/**
 * Generate a presigned URL for temporary access to R2 files
 * @param {string} key - The file key/path in R2
 * @param {number} expiresIn - URL expiration time in seconds (default: 1 hour)
 * @returns {Promise<Object>} Presigned URL result
 */
export async function getPresignedUrl(key, expiresIn = 3600) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const url = await getSignedUrl(r2Client, command, { expiresIn });

    return {
      success: true,
      url,
      expiresIn,
      storage: 'r2',
    };
  } catch (error) {
    console.error('R2 presigned URL error:', error);
    return {
      success: false,
      error: error.message,
      storage: 'r2',
    };
  }
}

/**
 * Extract R2 key from URL or return key if already a key
 * @param {string} urlOrKey - The R2 URL or key
 * @returns {string|null} The key or null if invalid
 */
export function extractR2Key(urlOrKey) {
  if (!urlOrKey) return null;
  
  // If it's already a key (doesn't start with http/https), clean it and return
  if (!urlOrKey.startsWith('http://') && !urlOrKey.startsWith('https://')) {
    // Remove any leading slashes or test/ prefix
    let key = urlOrKey.replace(/^\/+/, '').replace(/^test\//, '');
    return key;
  }
  
  try {
    const urlObj = new URL(urlOrKey);
    const pathname = urlObj.pathname;
    
    // Remove leading slash
    let key = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    
    // Remove common prefixes that might be in R2 public URLs
    // Common patterns: /test/, /bucket-name/, etc.
    key = key.replace(/^test\//, ''); // Remove /test/ prefix if present
    key = key.replace(/^[^\/]+\//, ''); // Remove bucket name prefix if present (first segment)
    
    // Ensure we have a valid key structure (Legacy/... or flashfirejobs/...)
    if (!key.startsWith('Legacy/') && !key.startsWith('flashfirejobs/')) {
      // Try to find the actual key part
      const match = key.match(/(Legacy|flashfirejobs)\/.+\.json/);
      if (match) {
        const keyIndex = key.indexOf(match[0]);
        key = key.substring(keyIndex);
      }
    }
    
    return key;
  } catch (error) {
    // If URL parsing fails, try to extract key from common patterns
    // Look for patterns like: /Legacy/... or /flashfirejobs/...
    const match = urlOrKey.match(/\/(Legacy|flashfirejobs)\/.+\.json/);
    if (match) {
      const keyMatch = urlOrKey.match(/\/(Legacy|flashfirejobs\/.+)$/);
      if (keyMatch) {
        return keyMatch[1].replace(/^\//, '');
      }
    }
    
    return null;
  }
}

/**
 * Check if URL is from R2
 * @param {string} url - The URL to check
 * @returns {boolean} True if R2 URL
 */
export function isR2Url(url) {
  if (!url) return false;
  return url.includes('.r2.cloudflarestorage.com') || 
         (PUBLIC_URL && url.startsWith(PUBLIC_URL));
}

/**
 * Upload JSON data to Cloudflare R2
 * @param {Object} jsonData - The JSON data to upload
 * @param {Object} options - Upload options
 * @param {string} options.clientName - Client email/identifier
 * @param {string} options.jobID - Job ID for the resume
 * @param {string} options.folder - Base folder (default: 'flashfirejobs')
 * @returns {Promise<Object>} Upload result with key and metadata
 */
export async function uploadJSONToR2(jsonData, options = {}) {
  try {
    const {
      clientName,
      jobID,
      folder = 'flashfirejobs',
    } = options;

    if (!clientName || !jobID) {
      throw new Error('clientName and jobID are required for JSON upload');
    }

    // Sanitize client name for folder structure
    const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Create folder structure: folder/clientName/resume-data/jobID.json
    const finalFolder = `${folder}/${sanitizedClientName}/resume-data`;
    const key = `${finalFolder}/${jobID}.json`;

    // Convert JSON to Buffer
    const jsonBuffer = Buffer.from(JSON.stringify(jsonData), 'utf-8');

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: jsonBuffer,
      ContentType: 'application/json',
      Metadata: {
        clientName: clientName,
        jobID: jobID,
        uploadedAt: new Date().toISOString(),
      },
    });

    await r2Client.send(command);

    console.log('R2 JSON Upload Success:', {
      key,
      folder: finalFolder,
      size: jsonBuffer.length,
    });

    return {
      success: true,
      key,
      bucket: BUCKET_NAME,
      size: jsonBuffer.length,
      storage: 'r2',
    };
  } catch (error) {
    console.error('R2 JSON upload error:', error);
    return {
      success: false,
      error: error.message,
      storage: 'r2',
    };
  }
}

/**
 * Retrieve JSON data from Cloudflare R2
 * @param {string} key - The R2 key for the JSON file
 * @returns {Promise<Object>} The JSON data or error
 */
export async function getJSONFromR2(key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const response = await r2Client.send(command);
    
    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    // Parse JSON
    const jsonData = JSON.parse(buffer.toString('utf-8'));

    console.log('R2 JSON Retrieve Success:', {
      key,
      size: buffer.length,
    });

    return {
      success: true,
      data: jsonData,
      storage: 'r2',
    };
  } catch (error) {
    console.error('R2 JSON retrieve error:', error);
    return {
      success: false,
      error: error.message,
      storage: 'r2',
    };
  }
}

/**
 * Read any object from R2 as bytes (e.g. an uploaded cover letter PDF).
 * @param {string} key - The R2 key
 * @returns {Promise<{success: true, buffer: Buffer, contentType: string} | {success: false, error: string}>}
 */
export async function getObjectFromR2(key) {
  try {
    const response = await r2Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const chunks = [];
    for await (const chunk of response.Body) chunks.push(chunk);
    return { success: true, buffer: Buffer.concat(chunks), contentType: response.ContentType || '' };
  } catch (error) {
    console.error('R2 object retrieve error:', error?.name || error?.message || error);
    return { success: false, error: error?.message || String(error) };
  }
}

/**
 * Check if JSON data exists in R2
 * @param {string} key - The R2 key to check
 * @returns {Promise<boolean>} True if exists
 */
export async function checkJSONExistsInR2(key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    await r2Client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      return false;
    }
    throw error;
  }
}

export default r2Client;

