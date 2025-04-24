import mongoose, { Schema, Document } from 'mongoose';
import Folder from './Folder';
import crypto from 'crypto';

function generateInitialsAvatar(name: string): string {
  const initials = name
    .split(' ')
    .map(part => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  
  // Generate a consistent background color based on the name
  const colors = [
    '#2196F3', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0',
    '#3F51B5', '#00BCD4', '#009688', '#FFC107', '#795548'
  ];
  
  const colorIndex = name
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  
  const backgroundColor = colors[colorIndex];
  
  // Create a Data URL for an SVG with the initials
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <rect width="100%" height="100%" fill="${backgroundColor}"/>
      <text x="50%" y="50%" dy=".1em"
        fill="white"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="Arial"
        font-size="80"
        font-weight="bold">${initials}</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export interface IUser extends Document {
  auth0Id: string;
  email: string;
  name: string;
  avatar: string;
  role: 'admin' | 'user' | 'manager';
  phoneNumber?: string;
  company?: string;
  position?: string;
  lastLogin: Date;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
  status: 'pending' | 'active';
}

const UserSchema = new Schema({
  auth0Id: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  avatar: { 
    type: String,
    default: function(this: { name: string }) {
      return generateInitialsAvatar(this.name);
    }
  },
  role: { type: String, enum: ['admin', 'user', 'manager'], default: 'user' },
  phoneNumber: String,
  company: String,
  position: String,
  lastLogin: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  tags: { type: [String], default: [] },
  status: {
    type: String,
    enum: ['pending', 'active'],
    default: 'pending'
  }
});

// Middleware to delete associated folders when a user is deleted
// UserSchema.pre('findOneAndDelete', async function (next) {
//   try {
//     const userId = this.getFilter()['_id']; // Get the user ID from the filter
//     await Folder.deleteMany({ userId }); // Delete all folders associated with this user

//     // Add more delete operations for other dependent models here
//     next();
//   } catch (error) {
//     next(error as Error);
//   }
// });

const User = mongoose.model<IUser>('User', UserSchema);
export default User;