import express from 'express';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import Task from '../models/Task';
import mongoose from 'mongoose';

const router = express.Router();

// Create new task
router.post('/', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const task = new Task({
      ...req.body,
      createdBy: req.user._id,
    });
    await task.save();
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: 'Error creating task' });
    console.log(error)
  }
});

// Get tasks (with filters)
router.get('/', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const query: any = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.priority) query.priority = req.query.priority;
    
    // Users can see tasks they created or are assigned to
    query.$or = [
      { createdBy: req.user._id },
      { assignedTo: req.user._id }
    ];

    const tasks = await Task.find(query)
      .populate('assignedTo', 'name email')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });
    
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching tasks' });
  }
});

router.get('/user/:userId', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const tasks = await Task.find({ assignedTo: new mongoose.Types.ObjectId(req.params.userId as string) });
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching tasks' });
  }
});

// Add comment to task
router.post('/:taskId/comments', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) {
       res.status(404).json({ message: 'Task not found' });
       return;
    }

    const newComment = {
      _id: new mongoose.Types.ObjectId(),
      user: req.user._id,
      content: req.body.content,
      createdAt: new Date(),
    };

    task.comments.push(newComment);

    await task.save();
    res.json(task);
  } catch (error) {
    res.status(500).json({ message: 'Error adding comment' });
  }
});

router.get('/:taskId/comments', validateAuth0Token, attachUser as express.RequestHandler, async(req, res)=>{
  const {taskId} = req.params;
  try {
    const task = await Task.findById(taskId).populate('comments.user');
    if(!task){
      res.status(404).json({message:'Task not found.'});
      return;
   }
   res.json(task.comments);
  } catch (error) {
    console.log(error)
    res.status(500).json({ message: 'Error fetching comments' });
  }
})

router.delete('/:taskId/comments/:commentId', validateAuth0Token, attachUser as express.RequestHandler, async(req, res) => {
  const { taskId, commentId } = req.params;

  try{
    const task = await Task.findById(taskId);
    if(!task){
       res.status(404).json({message:'Task not found.'});
       return;
    }

    const commentIndex = task.comments.findIndex(comment => {
      return comment._id.equals(new mongoose.Types.ObjectId(commentId))
    });

   if (commentIndex === -1) {
       res.status(404).json({ message: 'Comment not found' });
       return;
    }

    // Remove the comment from the task
    task.comments.splice(commentIndex, 1);
    await task.save();

    // Optionally, delete the comment from the Comment collection
    // await Comment.findByIdAndDelete(commentId);

    // Send a success response
    res.status(200).json({ message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ message: 'Error deleting comment' });
  }
});

export default router; 