import mongoose from 'mongoose';

export interface IFolder extends Document {
  name: string;
  parent: mongoose.Types.ObjectId;
  clientId: mongoose.Types.ObjectId; 
  createdBy: mongoose.Types.ObjectId;
  isDefault: boolean;
  isInternal: boolean;
}
const folderSchema = new mongoose.Schema({
  name: { type: String, required: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder' },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true  }, // For client-specific folders
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isDefault: { type: Boolean, default: false },
  isInternal: { type: Boolean, default: false }, // For admin-only folders
});

const Folder = mongoose.model('Folder', folderSchema);
export default Folder;