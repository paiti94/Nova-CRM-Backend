import express from 'express';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import Task from '../models/Task';
import mongoose from 'mongoose';

const router = express.Router();
// Create new task
router.post('/', validateAuth0Token, attachUser as express.RequestHandler, async (req, res) => {
  try {
    const assignedTo = toObjectIdArray(req.body.assignedTo);

    const priorityRaw = String(req.body.priority ?? 'medium').toLowerCase();
    const statusRaw   = String(req.body.status   ?? 'pending').toLowerCase();

    const priority: 'low'|'medium'|'high' =
      (['low','medium','high'] as const).includes(priorityRaw as any)
        ? (priorityRaw as any)
        : 'medium';

    const status: 'pending'|'in_progress'|'completed' =
      (['pending','in_progress','completed'] as const).includes(statusRaw as any)
        ? (statusRaw as any)
        : 'pending';

    const dueDate = parseDueDate(req.body.dueDate);

    const task = new Task({
      title: String(req.body.title ?? '').trim(),
      description: String(req.body.description ?? ''),
      priority,
      status,
      dueDate,
      assignedTo,              // ObjectId[]
      createdBy: req.user._id,
    });
    await task.validate();
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
    if (req.query.source) {
      query.source = new RegExp(`^${req.query.source}$`, 'i');
    }
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

router.get('/:taskId/comments', validateAuth0Token , attachUser as express.RequestHandler, async(req, res)=>{
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

// PATCH /tasks/:taskId  — update fields
router.patch('/:taskId', validateAuth0Token, attachUser as any, async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = (req as any).user._id as mongoose.Types.ObjectId;

    const task = await Task.findById(taskId);
    if (!task) { res.status(404).json({ message: 'Task not found' }); return; }

    const isOwner = task.createdBy?.toString() === userId.toString();
    const isAssignee = (task.assignedTo || []).some(id => id.toString() === userId.toString());
    if (!isOwner && !isAssignee) { res.status(403).json({ message: 'Not allowed' }); return; }

    const { status, priority, dueDate, assignedTo, title, description } = req.body as {
      status?: 'pending'|'in_progress'|'completed';
      priority?: 'low'|'medium'|'high';
      dueDate?: string | Date;
      assignedTo?: string[];          // array of userIds
      title?: string;
      description?: string;
    };

    if (status && !['pending','in_progress','completed'].includes(status)) {
      res.status(400).json({ message: 'Invalid status' }); return;
    }
    if (priority && !['low','medium','high'].includes(priority)) {
      res.status(400).json({ message: 'Invalid priority' }); return;
    }

    // Apply updates
    if (typeof title === 'string') task.title = title;
    if (typeof description === 'string') task.description = description;
    if (status) task.status = status;
    if (priority) task.priority = priority;
    if (dueDate) task.dueDate = new Date(dueDate);
    if (Array.isArray(assignedTo)) {
      task.assignedTo = assignedTo.map(id => new mongoose.Types.ObjectId(id));
    }
    task.updatedAt = new Date();

    await task.save();
    const populated = await Task.findById(task._id)
      .populate('assignedTo','name email')
      .populate('createdBy','name email');
    res.json(populated);
  } catch (err) {
    console.error('update task error', err);
    res.status(500).json({ message: 'Error updating task' });
  }
});

// PATCH /tasks/:taskId/complete — mark completed
router.patch('/:taskId/complete', validateAuth0Token, attachUser as any, async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = (req as any).user._id as mongoose.Types.ObjectId;

    const task = await Task.findById(taskId);
    if (!task) { res.status(404).json({ message: 'Task not found' }); return; }

    const allowed = task.createdBy?.toString() === String(userId) ||
      (task.assignedTo || []).some(id => id.toString() === String(userId));
    if (!allowed) { res.status(403).json({ message: 'Not allowed' }); return; }

    task.status = 'completed';
    task.updatedAt = new Date();
    await task.save();
    res.json(task);
  } catch (e) {
    res.status(500).json({ message: 'Error completing task' });
  }
});

// DELETE /tasks/:taskId — delete
router.delete('/:taskId', validateAuth0Token, attachUser as any, async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = (req as any).user._id as mongoose.Types.ObjectId;

    const task = await Task.findById(taskId);
    if (!task) { res.status(404).json({ message: 'Task not found' }); return; }

    // Only creator can delete (adjust if you want assignees too)
    if (task.createdBy?.toString() !== String(userId)) {
      res.status(403).json({ message: 'Only creator can delete' }); return;
    }

    await Task.findByIdAndDelete(taskId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: 'Error deleting task' });
  }
});

export default router; 

function toObjectIdArray(input: unknown): mongoose.Types.ObjectId[] {
  const ids = Array.isArray(input) ? input : input ? [input] : [];
  return ids
    .filter((v) => typeof v === 'string' && mongoose.isValidObjectId(v))
    .map((v) => new mongoose.Types.ObjectId(v as string));
}

function parseDueDate(input: unknown): Date | undefined {
  if (!input || typeof input !== 'string') return undefined;
  // If it's date-only (yyyy-mm-dd), set end-of-day 17:00 local to reduce TZ surprise
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 17, 0, 0, 0);
    return isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(input);
  return isNaN(d.getTime()) ? undefined : d;
}
