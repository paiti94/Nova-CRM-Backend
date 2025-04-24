export interface FileUploadMetadata {
  name: string;
  type: string;
  size: number;
  key: string;
  folderId?: string;
  clientId?: string;
  parent?: string;
}

export interface PresignedUrlResponse {
  presignedUrl: string;
  key: string;
}

export interface FileDownloadResponse {
  downloadUrl: string;
} 