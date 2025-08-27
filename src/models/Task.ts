import mongoose, { Schema, Document } from 'mongoose';
export interface IComment {
  _id: mongoose.Types.ObjectId; // Add the _id property
  user: mongoose.Types.ObjectId;
  content: string;
  createdAt: Date;
}
export interface ITask extends Document {
  title: string;
  description: string;
  assignedTo: mongoose.Types.ObjectId[];
  createdBy: mongoose.Types.ObjectId;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high';
  dueDate: Date;
  attachments: mongoose.Types.ObjectId[];
  comments: IComment[];
  createdAt: Date;
  updatedAt: Date;

  // NEW: source metadata
  source?: 'manual' | 'outlook';
  sourceEmailId?: string;     // Graph message id
  sourceThreadId?: string;    // conversationId
  sourceWebLink?: string;     // Outlook web link
  sourceFromName?: string;
  sourceFromAddress?: string;
  sourceReceivedAt?: Date;
  sourceSubject?: string;
  sourceSnippet?: string;     // short plain-text excerpt used for AI
}

const TaskSchema = new Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User'  }],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed'],
    default: 'pending'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  dueDate: { type: Date, required: true },
  attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],  
  comments: [{
    _id: { type: Schema.Types.ObjectId, auto: true }, // Ensure _id is included
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    content: String,
    createdAt: { type: Date, default: Date.now },
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  source: { type: String, enum: ['manual', 'outlook'], default: 'manual' },
  sourceEmailId: { type: String, index: true },
  sourceThreadId: { type: String },
  sourceWebLink: { type: String },
  sourceFromName: { type: String },
  sourceFromAddress: { type: String },
  sourceReceivedAt: { type: Date },
  sourceSubject: { type: String },
  sourceSnippet: { type: String }, 
}, { timestamps: true });

TaskSchema.index(
  { createdBy: 1, source: 1, sourceEmailId: 1 },
  { unique: true, partialFilterExpression: { source: { $exists: true }, sourceEmailId: { $exists: true } } }
);
const Task = mongoose.model<ITask>('Task', TaskSchema);

export default Task;