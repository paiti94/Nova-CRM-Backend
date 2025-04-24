import mongoose from 'mongoose';
import Folder from '../models/Folder';
import User, { IUser } from '../models/User';
export class FolderService {
  static readonly DEFAULT_FOLDERS = {
    CLIENT_SHARED: 'Client Shared Folder',
    INTERNAL: 'Internal Folder',
    ROOT: 'Root Folder',
  };

  static async createDefaultFolders(client: IUser) {
    try {
      // Create or update the Root folder for the specific client
      const rootFolder = await Folder.findOneAndUpdate(
        { name: this.DEFAULT_FOLDERS.ROOT, clientId: client._id }, // Include clientId in the query
        {
          name: this.DEFAULT_FOLDERS.ROOT,
          createdBy: null,
          isDefault: true,
          isInternal: false,
          clientId: client._id,
          parent: null // Root folder has no parent
        },
        { upsert: true, new: true } // Return the new document
      );

      // Create Internal folder if it doesn't exist for the specific client
      await Folder.findOneAndUpdate(
        { name: this.DEFAULT_FOLDERS.INTERNAL, clientId: client._id, isDefault: true }, // Include clientId in the query
        {
          name: this.DEFAULT_FOLDERS.INTERNAL,
          createdBy: null,
          isDefault: true,
          isInternal: true,
          clientId: client._id,
          parent: rootFolder._id,
        },
        { upsert: true }
      );

      // Create Client Shared folder if it doesn't exist for the specific client
      await Folder.findOneAndUpdate(
        { name: this.DEFAULT_FOLDERS.CLIENT_SHARED, clientId: client._id, isDefault: true }, // Include clientId in the query
        {
          name: this.DEFAULT_FOLDERS.CLIENT_SHARED,
          createdBy: null,
          isDefault: true,
          isInternal: false,
          clientId: client._id,
          parent: rootFolder._id,
        },
        { upsert: true }
      );

      return true;
    } catch (error) {
      console.error('Error creating default folders:', error);
      throw error;
    }
  }
}