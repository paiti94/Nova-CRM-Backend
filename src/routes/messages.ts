import express from 'express';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import Message from '../models/Message';
import mongoose from 'mongoose';

const router = express.Router();

router.post('/', async (req, res) => {
  const { sender, receiver, content, type } = req.body;

  try {
    const message = new Message({
      sender,
      receiver,
      content,
      type,
      read: false,
      createdAt: new Date(),
    });

    await message.save();
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

router.get('/unreadcounts/:userId', async (req, res) => {
  const { userId } = req.params;
  console.log("this is userId", userId);
  try {
    const unreadCounts = await Message.aggregate([
      { $match: { receiver: new mongoose.Types.ObjectId(userId), read: false } },
      { $group: { _id: "$sender", count: { $sum: 1 } } } // Group by sender and count unread messages
    ]);

    // Transform the result into a more usable format
    const unreadCountMap: Record<string, number> = {};
    unreadCounts.forEach(({ _id, count }) => {
      unreadCountMap[_id.toString()] = count; // Map sender ID to unread count
    });

    console.log("this is unread count", unreadCountMap);

    res.status(200).json(unreadCountMap);
  } catch (error) {
    console.error('Error fetching unread counts:', error);
    res.status(500).json({ message: 'Error fetching unread counts', error });
  }
});

router.get('/:senderId/:receiverId', async (req, res) => {
  const { senderId, receiverId } = req.params;

  try {
    const messages = await Message.find({
      $or: [
        { sender: new mongoose.Types.ObjectId(senderId as string)  , receiver: new mongoose.Types.ObjectId(receiverId as string) },
        { sender: new mongoose.Types.ObjectId(receiverId as string), receiver: new mongoose.Types.ObjectId(senderId as string) },
      ],
    }).sort({ createdAt: 1 }); // Sort messages by creation date

    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.patch('/read/:receiver',   async (req, res) => {
  const { receiver } = req.params;
  const { userId } = req.body;

  try {
    const result = await Message.updateMany(
      { receiver: userId }, // Find by receiver field
      { read: true } // Update the read field to true
    );

    if (result.modifiedCount === 0) {
       res.status(404).json({ message: 'No messages found for the specified receiver' });
       return;
    }

    res.status(200).json({ message: 'Messages marked as read', updatedCount: result.modifiedCount });
  } catch (error) {
    console.error('Error marking messages as read:', error); // Log the error for debugging
    res.status(500).json({ message: 'Error marking messages as read', error });
  }
});


// router.patch('/read/:contactId', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
//   const { contactId } = req.params;
//   const { userId } = req.body; // Assuming you send the userId in the request body

//   try {
//     await Message.updateMany(
//       { receiver: userId, sender: contactId, read: false },
//       { read: true }
//     );

//     res.status(200).json({ message: 'Messages marked as read' });
//   } catch (error) {
//     res.status(500).json({ message: 'Error marking messages as read', error });
//   }
// });

export default router; 

