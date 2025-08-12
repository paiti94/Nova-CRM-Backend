import mongoose, { Schema, Document } from 'mongoose';

export interface IFile extends Document {
    name: string;
    type: string;
    size: number;
    key: string; // S3 key
    url?: string; // Optional public URL
    folder?: mongoose.Types.ObjectId; // Optional reference to Folder
    uploadedBy: mongoose.Types.ObjectId; // Reference to User
    clientId?: mongoose.Types.ObjectId; // Reference to User
    accessibleTo: mongoose.Types.ObjectId[]; // Users who can access this file
    isPublic: boolean;
    createdAt: Date;
    updatedAt: Date;
    task?: mongoose.Types.ObjectId; // Reference to Task
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }];
}
const FileSchema = new Schema({
    name: { type: String, required: true },
    type: { type: String, required: true },
    size: { type: Number, required: true },
    key: { type: String, required: true }, // S3 key
    url: { type: String }, // Optional public URL
    folder: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // The client this file belongs to
    accessibleTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Users who can access this file
    isPublic: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    task: { type:mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

const File = mongoose.model('File', FileSchema);
export default File;