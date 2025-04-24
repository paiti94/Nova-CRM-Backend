import mongoose, { Schema, Document } from 'mongoose';

export interface ITag extends Document {
  value: string; // machine-readable (e.g., "gst_filing")
  label: string; // human-readable (e.g., "GST Filing")
  createdAt: Date;
}

const TagSchema = new Schema<ITag>({
  value: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Tag = mongoose.model<ITag>('Tag', TagSchema);
export default Tag;
