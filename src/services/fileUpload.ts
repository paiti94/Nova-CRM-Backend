import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand,
  DeleteObjectCommand, 
  S3,
  CopyObjectCommand,
  GetObjectCommandOutput
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import { Readable } from 'stream';

dotenv.config();

export class FileUploadService {
  private s3Client: S3Client;
  private bucket: string;

  constructor() {
    if (!process.env.AWS_ACCESS_KEY_ID || 
        !process.env.AWS_SECRET_ACCESS_KEY || 
        !process.env.AWS_REGION || 
        !process.env.AWS_BUCKET_NAME) {
      throw new Error('Missing required AWS configuration');
    }

    this.s3Client = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    this.bucket = process.env.AWS_BUCKET_NAME;
  }

  async generatePresignedUrl(key: string, contentType: string): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 3600, 
      });

      return signedUrl;
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      throw new Error('Failed to generate upload URL');
    }
  }

  async generatePresignedUrlForUploading(key: string, contentType: string): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        // expiresIn: 3600, 
        expiresIn: 120, 
      });

      return signedUrl;
    } catch (error) {
      console.error('Error generating presigned URL for Uploading:', error);
      throw new Error('Failed to generate upload URL');
    }
  }

  async copyFile(oldKey: string, newKey: string) {
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        CopySource: `${process.env.AWS_BUCKET_NAME}/${oldKey}`,
        Key: newKey,
      })
    );
  }

  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
    } catch (error) {
      console.error('Error deleting file:', error);
      throw new Error('Failed to delete file');
    }
  }

  generateFileKey(fileName: string, userId: string, folderId?: string): string {
    const timestamp = Date.now();
    if (!fileName || !userId || !folderId) {
      throw new Error('Invalid parameters for generating file key');
    }
  
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const folderPath = folderId ? `${folderId}/` : '';
    return `${userId}/${folderPath}${timestamp}-${sanitizedFileName}`;
  }

  async getReadStream(key: string): Promise<{ Body: Readable } | null> {
    try {
      const cmd = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const data: GetObjectCommandOutput = await this.s3Client.send(cmd);
      const stream = data.Body as Readable | undefined;
      if (stream && typeof stream.pipe === 'function') {
        return { Body: stream };
      } else {
        console.error('getReadStream: S3 did not return a Node.js stream');
        return null;
      }
    } catch (err) {
      console.error('getReadStream error:', err);
      return null;
    }
  }
} 