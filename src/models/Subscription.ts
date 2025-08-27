import mongoose, { Schema } from 'mongoose';

const SubscriptionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  subscriptionId: { type: String, index: true, required: true },
  resource: { type: String },
  clientState: { type: String },
  expirationDateTime: { type: Date, required: true },
}, { timestamps: true });

SubscriptionSchema.index({ userId: 1 }, { unique: true });
export default mongoose.model('Subscription', SubscriptionSchema);


