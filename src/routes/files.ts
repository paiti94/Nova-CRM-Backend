import express from 'express';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import { FileUploadService } from '../services/fileUpload';
import File from '../models/File';
import Folder from '../models/Folder';
import { FolderService } from '../services/folderService';
import mongoose from 'mongoose';

const router = express.Router();
const fileUploadService = new FileUploadService();



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

// Save file metadata after upload
router.post('/', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    console.log('File metadata save attempt:', {
      path: req.path,
      method: req.method,
      body: req.body,
    });
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
      readBy: [], 
    });
    await file.save();
    res.status(201).json(file);
  } catch (error) {
    res.status(500).json({ message: 'Error saving file metadata' });
    console.error('Error saving file metadata:', error);
  }
});

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

// PATCH /files/:fileId/mark-read
router.patch('/:fileId/mark-read', async (req, res) => {
  const { fileId } = req.params;
  const userId = req.body.userId;

  if (!userId)  {
    res.status(400).json({ error: 'Missing userId' });
    return;
  }

  try {
    await File.findByIdAndUpdate(fileId, {
      $addToSet: { readBy: userId }, // prevents duplicates
    });
     res.json({ message: 'Marked as read' });
     return;
  } catch (err) {
     res.status(500).json({ error: 'Failed to mark as read' });
     return;
  }
});

// GET /files/unread-count?clientId=xxx&userId=xxx
router.get('/unread-count', async (req, res) => {
  const { clientId, userId } = req.query;

  if (!clientId || !userId) {
     res.status(400).json({ error: 'Missing clientId or userId' });
     return;
  }

  try {
    const count = await File.countDocuments({
      clientId,
      readBy: { $ne: userId },
    });

     res.json({ unreadCount: count });
     return;
  } catch (err) {
     res.status(500).json({ error: 'Failed to count unread files' });
     return;
  }
});


export default router;