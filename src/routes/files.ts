import express from 'express';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import { FileUploadService } from '../services/fileUpload';
import File from '../models/File';
import Folder from '../models/Folder';
import { FolderService } from '../services/folderService';
import mongoose from 'mongoose';
import archiver from 'archiver'; 
import { Readable } from 'stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
const router = express.Router();
const fileUploadService = new FileUploadService();
import { sendSmtp2GoEmail } from '../services/emailService';
import User from '../models/User';

router.get('/folders', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userId = req.user._id;
    const { clientId } = req.query; 
    const { folderId } = req.query;

    let folderQuery: any = {};

    if (isAdmin && clientId && !folderId) {
      folderQuery = { 
        clientId: new mongoose.Types.ObjectId(clientId as string) 
    };
    } else if(isAdmin && folderId && !clientId){
      folderQuery = {
        _id: new mongoose.Types.ObjectId(folderId as string)
      };
    } else {
      folderQuery = {
        clientId: userId, 
        isInternal: false,
      };
    }

    const folders = await Folder.find(folderQuery).sort({ isDefault: -1, name: 1 });
    res.json(folders); 
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ message: 'Error fetching folders' });
  }
});

// Get folder contents
router.get('/folders/contents/:folderId', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const { folderId } = req.params;
    const isAdmin = req.user.role === 'admin';
    const folder = await Folder.findById(folderId);

    if (!folder) {
       res.status(404).json({ message: 'Folder not found' });
       return
    }

    // Check access permissions
    if (!isAdmin && folder.isInternal) {
       res.status(403).json({ message: 'Access denied' });
       return;
    }
    if (!isAdmin && folder.clientId && !folder.clientId.equals(req.user._id)) {
       res.status(403).json({ message: 'Access denied' });
       return;
    }

    const [files, subFolders] = await Promise.all([
        File.find({ folder: folderId }),
        Folder.find({ parentId: folderId })
      ]);
    res.json({ files, folders: subFolders });
  } catch (error) {
    console.error('Error fetching folder contents:', error);
    res.status(500).json({ message: 'Error fetching folder contents' });
  }
});

router.get('/task/:taskId', validateAuth0Token, attachUser as express.RequestHandler, async(req,res)=>{
  try{
    const { taskId } = req.params;
    const files = await File.find({ task: taskId });
    if(!files || files.length === 0){
      res.status(404).json({ message: 'Files with task not found' });
      return;
    }
    res.json(files);
  }catch(error){
    console.error('Error getting files with task:', error);
    res.status(500).json({ message: 'Error getting files with task', error: error});
  }
})

// Create a new folder inside Client Shared
router.post('/folders', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    console.log('File upload attempt:', {
        path: req.path,
        method: req.method,
        body: req.body,
      });
    const { name, parentId, clientId, taskId } = req.body;
    const isAdmin = req.user.role === 'admin';
    console.log('Creating folder - Request details:', {
        body: req.body,
        user: {
          id: req.user._id,
          role: req.user.role
        },
        isAdmin
      });

    // Check if parent folder exists and user has access
    if (parentId) {
      const parentFolder = await Folder.findById(parentId);
      if (!parentFolder) {
         res.status(404).json({ message: 'Parent folder not found' });
         return;
      }

      if (!isAdmin && parentFolder.isInternal) {
         res.status(403).json({ message: 'Cannot create folder in Internal folder' });
        return;
      }
    }

    const folder = new Folder({
      name,
      parent: parentId ? new mongoose.Types.ObjectId(parentId as string) : null,
      clientId: !isAdmin ? req.user._id : new mongoose.Types.ObjectId(clientId as string), //to update the clientId to the user's id
      createdBy: req.user._id,
      isDefault: false,
      isInternal: isAdmin ? req.body.isInternal : false,
      task: taskId ? new mongoose.Types.ObjectId(taskId as string) : null,
    });

    await folder.save();
    res.status(201).json(folder);
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ message: 'Error creating folder', error: error});
  }
});

// Get presigned URL for upload
router.post('/presigned-url', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const { fileName, fileType, folderId, clientId } = req.body;
    console.log(req.body);
    if (!fileName || !folderId || !clientId) {
       res.status(400).json({ message: 'Missing required fields' });
       return;
    }
    const key = fileUploadService.generateFileKey(fileName, req.user._id, folderId);
    const presignedUrl = await fileUploadService.generatePresignedUrlForUploading(key, fileType);
    
    res.json({ presignedUrl, key });
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({ message: 'Error generating upload URL' });
  }
});


router.post('/', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
    try {
      const { name, type, size, key, folderId, clientId, taskId } = req.body;
      const file = new File({
        name,
        type,
        size,
        key,
        folder: folderId || null,
        uploadedBy: req.user._id,
        clientId: clientId || null,
        accessibleTo: clientId ? [clientId] : [],
        task: taskId || null,
      });

      await file.save();
      const fileUrl = `${process.env.CRM_URL}/files/`;

      if (req.user.role === 'admin' && clientId) {
        // Admin uploaded for a user -> notify only the user
        const clientUser = await User.findById(clientId);
        if (clientUser && clientUser.email) {
          await sendSmtp2GoEmail(
            clientUser.email,
            'A new file has been uploaded for you',
            `A new file "${file.name}" has been uploaded by your accountant. View: ${fileUrl}`,
            `<p>A new file <b>${file.name}</b> has been uploaded by your accountant.</p>
             <p><a href="${fileUrl}">View your file in CRM</a></p>`,
            req.user.email
          );
        }
      } else if (req.user.role !== 'admin') {
        // Non-admin uploaded -> notify all admins
        const adminEmails = ['paiti94@gmail.com', 'ali@novatax.ca'];
        await sendSmtp2GoEmail(
          adminEmails,
          `New file uploaded by ${req.user.name || req.user.email}`,
          `A new file "${file.name}" was uploaded by ${req.user.name || req.user.email}. View: ${fileUrl}`,
          `<p>A new file <b>${file.name}</b> was uploaded by <b>${req.user.name || req.user.email}</b>.</p>
           <p><a href="${fileUrl}">View in CRM</a></p>`,
          req.user.email
        );
      }


      res.status(201).json(file);
    } catch (error) {
      res.status(500).json({ message: 'Error saving file metadata' });
      console.error('Error saving file metadata:', error);
    }
  }
);
// Get download URL
router.get('/download/:fileId', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const fileId = req.params.fileId;
    if(!fileId) {
      res.status(400).json({ message: 'File ID is required' });
      return;
    }
    const file = await File.findById(fileId);
    if (!file) {
      res.status(404).json({ message: 'File not found' });
      return;
    }

    // Check access permissions
    const canAccess = 
      file.uploadedBy.equals(req.user._id) ||
      file.accessibleTo.includes(req.user._id) ||
      (file.clientId && file.clientId.equals(req.user._id)) ||
      req.user.role === 'admin';

    if (!canAccess) {
      res.status(403).json({ message: 'Access denied' });
      return;
    }
    console.log('Generating presigned URL for key:', file.key);

    await File.findByIdAndUpdate(fileId, {
      $addToSet: { readBy: req.user._id }
    });

    const downloadUrl = await fileUploadService.generatePresignedUrl(file.key, file.type);
    res.json({ downloadUrl });
  } catch (error) {
    res.status(500).json({ message: 'Error generating download URL' });
  }
});

// Delete file
router.delete('/:fileId', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const file = await File.findById(req.params.fileId);
    if (!file) {
      res.status(404).json({ message: 'File not found' });
      return;
    }

    // Check permissions
    if (!file.uploadedBy.equals(req.user._id) && req.user.role !== 'admin') {
      res.status(403).json({ message: 'Permission denied' });
      return;
    }

    // Delete from S3
    await fileUploadService.deleteFile(file.key);
    
    // Delete from database
    await file.deleteOne();

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ message: 'Error deleting file' });
  }
});

// Delete folder and its contents
router.delete('/folders/:folderId', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const { folderId } = req.params;
    const { recursive } = req.query;

    // Get the folder
    const folder = await Folder.findById(folderId);
    if (!folder) {
       res.status(404).json({ message: 'Folder not found' });
    }else{
      // Check if user is admin
      if (req.user.role !== 'admin') {
        res.status(403).json({ message: 'Not authorized' });
      }
      
      if (folder.isDefault) {
        res.status(400).json({ message: 'Cannot delete default folders' });
      }
      
      if (recursive === 'true') {
       // Get all child folders recursively
       const getAllChildFolders = async (parentId: string): Promise<string[]> => {
         const children = await Folder.find({ parent: parentId });
         const childIds = children.map(c => c._id.toString());
         const grandChildren = await Promise.all(
           children.map(child => getAllChildFolders(child._id.toString()))
         );
         return [...childIds, ...grandChildren.flat()];
       };
     
       const childFolderIds = await getAllChildFolders(folderId);
       
       // Delete all files in these folders
       await File.deleteMany({
         folderId: { $in: [...childFolderIds, folderId] }
       });
     
       // Delete all child folders
       await Folder.deleteMany({
         _id: { $in: childFolderIds }
       });
      }
      
      // Delete the folder itself
      await Folder.findByIdAndDelete(folderId);
      
      res.json({ message: 'Folder and contents deleted successfully' });
    }
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ message: 'Error deleting folder' });
  }
});

router.patch('/:fileId/move', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const { fileId } = req.params;
    const { folderId } = req.body;
    if (!folderId) {
      res.status(400).json({ message: 'folderId is required' }); 
      return;
    } 

    const file = await File.findById(fileId);
    if (!file) {
       res.status(404).json({ message: 'File not found' });
       return;
    } 

    if (!file.uploadedBy.equals(req.user._id) && req.user.role !== 'admin'){
       res.status(403).json({ message: 'Permission denied' });
       return;
    }

    const targetFolder = await Folder.findById(folderId);
    if (!targetFolder) {
       res.status(404).json({ message: 'Target folder not found' });
       return;
    }

    if (targetFolder.isInternal && req.user.role !== 'admin'){
       res.status(403).json({ message: 'Cannot move to internal folder' });
       return;
    }
      
    if (targetFolder.clientId && !targetFolder.clientId.equals(req.user._id) && req.user.role !== 'admin'){
       res.status(403).json({ message: "Cannot move to another user's folder" });
       return;
    }

    const oldKey = file.key;

    // --------- PRESERVE TIMESTAMP ----------
    const match = oldKey.match(/(\d+)-[^/]+$/);
    const timestamp = match ? match[1] : Date.now();
    const sanitizedFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const newKey = `${file.uploadedBy}/${folderId}/${timestamp}-${sanitizedFileName}`;
    // ---------------------------------------

    if (oldKey !== newKey) {
      const fileUploadService = new FileUploadService();
      await fileUploadService.copyFile(oldKey, newKey);
      await fileUploadService.deleteFile(oldKey);
      file.key = newKey;
    }

    file.folder = folderId;
    await file.save();

    res.json({ message: 'File moved successfully', file });
  } catch (error) {
    console.error('Error moving file:', error);
    res.status(500).json({ message: 'Error moving file' });
  }
});

router.get('/folders/:folderId/download-all', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
    const { folderId } = req.params;
    try {
      // 1. Find all files for this folder
      const files = await File.find({ folder: folderId });
      if (!files.length) {
        res.status(404).json({ message: 'No files to download' });
        return;
      }

      // 2. Set headers
      res.setHeader('Content-Disposition', `attachment; filename="folder-${folderId}.zip"`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');

      // 3. Create the archive and pipe to response
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', err => {
        console.error('Archiver error:', err);
        if (!res.headersSent) res.status(500).end();
      });
      archive.pipe(res);

      // 4. Use your fileUploadService to stream each file from S3 into the ZIP
      for (const file of files) {
        try {
          const s3Result = await fileUploadService.getReadStream(file.key);
          if (s3Result && s3Result.Body) {
            archive.append(s3Result.Body, { name: file.name });
            console.log(`Added file: ${file.name}`);
          } else {
            console.warn(`Could NOT fetch: ${file.key} -- added .txt instead`);
            archive.append(`Could not fetch file: ${file.key}`, { name: file.name + '.txt' });
          }
        } catch (err) {
          console.error(`Error streaming file ${file.key}:`, err);
          archive.append(`Error fetching file: ${file.key}`, { name: file.name + '.txt' });
        }
      }
      
      await File.updateMany(
        { folder: folderId },
        { $addToSet: { readBy: req.user._id } }
      );
      // 5. Finalize the zip (triggers sending)
      await archive.finalize();
    } catch (err) {
      console.error('Error generating zip:', err);
      if (!res.headersSent) res.status(500).end();
    }
  }
);

export default router;