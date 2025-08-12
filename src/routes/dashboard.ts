import express, { Request, Response } from 'express';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import User from '../models/User';
import Task from '../models/Task';
import Message from '../models/Message';
import File from '../models/File';
import mongoose from 'mongoose';

const router = express.Router();

// Get dashboard statistics
router.get('/stats', validateAuth0Token, attachUser as express.RequestHandler, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    const isAdmin = req.user.role === 'admin';
    const adminUsers = await User.find({ role: 'admin' }, '_id');
    const adminIds = adminUsers.map(u => u._id);

    console.log('Current Date:', now);
    console.log('Last Month Date:', lastMonth);

    if (isAdmin) {
      const [
        currentClientsCount,
        lastMonthClientsCount,
        currentTasksCount,
        lastMonthTasksCount,
        currentMessagesCount,
        lastMonthMessagesCount,
        currentFilesCount,
        lastMonthFilesCount
      ] = await Promise.all([
        User.countDocuments({ createdAt: { $gte: lastMonth } }),
        User.countDocuments({ createdAt: { $lt: lastMonth } }),
        Task.countDocuments({ createdAt: { $gte: lastMonth } }),
        Task.countDocuments({ createdAt: { $lt: lastMonth } }),
        // Message.countDocuments({ createdAt: { $gte: lastMonth, receiver: new mongoose.Types.ObjectId(req.user._id as string), read: false } }),
        // Message.countDocuments({ createdAt: { $lt: lastMonth, receiver: new mongoose.Types.ObjectId(req.user._id as string), read: false } }),
        Message.countDocuments({ createdAt: { $gte: lastMonth}, receiver: new mongoose.Types.ObjectId(req.user._id as string), read: false }),
        Message.countDocuments({ createdAt: { $lt: lastMonth }, receiver: new mongoose.Types.ObjectId(req.user._id as string), read: false }),
        File.countDocuments({ createdAt: { $gte: lastMonth } }),
        File.countDocuments({ createdAt: { $lt: lastMonth } })
      ]);

      // Calculate growth percentages
      const calculateGrowth = (current: number, previous: number) => {
        if (previous === 0) return 100;
        return Math.round(((current - previous) / previous) * 100);
      };
      const unopenedFilesCount = await File.countDocuments({
        uploadedBy: { $ne: req.user._id },
        $or: [
          { readBy: { $exists: false } },
          { readBy: { $not: { $elemMatch: { $eq: req.user._id } } } }
        ]
      });
      const stats = {
        totalClients: currentClientsCount + lastMonthClientsCount,
        totalTasks: currentTasksCount + lastMonthTasksCount,
        totalMessages: currentMessagesCount + lastMonthMessagesCount,
        totalFiles: currentFilesCount + lastMonthFilesCount,
        clientGrowth: calculateGrowth(currentClientsCount, lastMonthClientsCount),
        taskGrowth: calculateGrowth(currentTasksCount, lastMonthTasksCount),
        messageGrowth: calculateGrowth(currentMessagesCount, lastMonthMessagesCount),
        fileGrowth: calculateGrowth(currentFilesCount, lastMonthFilesCount),
        unOpenedFiles: unopenedFilesCount,
      };
      res.json(stats);

    } else {
      const clientId = req.user._id;

      const [
        totalTasks,
        totalFiles,
        totalMessages
      ] = await Promise.all([
        Task.countDocuments({ assignedTo: new mongoose.Types.ObjectId(clientId as string) }),
        File.countDocuments({ clientId: new mongoose.Types.ObjectId(clientId as string) }),
        Message.countDocuments({ receiver: new mongoose.Types.ObjectId(clientId as string), read: false })
      ]);

      const unopenedFilesCount = await File.countDocuments({
        clientId: req.user._id,
        uploadedBy: { $in: adminIds },
        // File is considered unopened IF:
        //   - readBy does not exist
        //   - OR readBy does NOT include me
        $or: [
          { readBy: { $exists: false } },
          { readBy: { $not: { $elemMatch: { $eq: req.user._id } } } }
        ]
      });

      const stats = {
        totalTasks,
        totalFiles,
        totalMessages,
        unOpenedFiles: unopenedFilesCount
      };
      res.json(stats);
    }
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ message: 'Error fetching dashboard statistics' });
  }
});

export default router;