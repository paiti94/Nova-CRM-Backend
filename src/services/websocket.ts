import { Server } from 'socket.io';
import { Server as HTTPServer } from 'http';

import Message from '../models/Message'; 
import { IMessage } from '../models/Message';

export class WebSocketService {
  private io: Server;
  private userSockets: Map<string, string> = new Map();

  constructor(server: HTTPServer) {
    this.io = new Server(server, {
      cors: {
        origin: process.env.CLIENT_URL || 'http://localhost:5173',
        methods: ['GET', 'POST']
      }
    });

    this.io.on('connection', (socket) => {
      // console.log('Client connected');

      socket.on('register', (userId: string) => {
        this.userSockets.set(userId, socket.id);
      });

      socket.on('message', async (message: IMessage) => {
        // Save message to database
        const newMessage = new Message(message);
        await newMessage.save();

        // Emit to recipient if online
        const recipientSocketId = this.userSockets.get(message.receiver.toString());
        if (recipientSocketId) {
          this.io.to(recipientSocketId).emit('message', newMessage);
        }
      });

      socket.on('disconnect', () => {
        // Remove user from userSockets map
        for (const [userId, socketId] of this.userSockets.entries()) {
          if (socketId === socket.id) {
            this.userSockets.delete(userId);
            break;
          }
        }
      });
    });
  }
}