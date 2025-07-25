import express, { Express, Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import mongoose, { Schema, Document } from 'mongoose';
import dotenv from 'dotenv';
import userRouter from './routes/users';
import messageRouter from './routes/messages';
import taskRouter from './routes/tasks';
import fileRouter from './routes/files';
import dashboardRouter from './routes/dashboard';
import tagRouter from './routes/tags';
import { createServer } from 'http';
import { WebSocketService } from './services/websocket';
import { FolderService } from './services/folderService';
import adminRouter from './routes/adminRoutes';
import { attachUser, validateAuth0Token } from './middleware/auth';

dotenv.config();
// Override console.log before any other imports
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  originalConsoleLog(new Date().toISOString(), '-', ...args);
};

console.error = (...args) => {
  originalConsoleError(new Date().toISOString(), '- ERROR:', ...args);
};
const app: Express = express();
const port = process.env.PORT || 5001;

const allowedOrigins = [
  'http://localhost:5173',
  'https://nova-crm-frontend.vercel.app'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));


app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Routes - just use the combined router
app.use('/api/users', userRouter);

// Protected routes - add middleware here
const protectedRoutes = express.Router();
protectedRoutes.use(validateAuth0Token);
protectedRoutes.use(attachUser as RequestHandler);

// Add your protected routes
protectedRoutes.use('/messages', messageRouter);
protectedRoutes.use('/tasks', taskRouter);
protectedRoutes.use('/files', fileRouter);
protectedRoutes.use('/dashboard', dashboardRouter);
protectedRoutes.use('/admin', adminRouter);
protectedRoutes.use('/tags', tagRouter);

// Use the protected routes after the public ones
app.use('/api', protectedRoutes);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error details:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body
  });
  res.status(500).send('Something broke!');
});

const httpServer = createServer(app);
const wsService = new WebSocketService(httpServer);

// Database connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://paiti94:115Blue!@jinnymongodb.bw32s.mongodb.net/CRM?retryWrites=true&w=majority&appName=JinnyMongoDB';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('MongoDB connection error:', error));

// Basic route
app.get('/', (req: Request, res: Response) => {
  res.send('Express + TypeScript Server is running');
});

httpServer.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

