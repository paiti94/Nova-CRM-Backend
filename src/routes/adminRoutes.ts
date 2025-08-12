import express from 'express';
import User from '../models/User';
import { validateAuth0Token, } from '../middleware/auth';

const router = express.Router();

// Special endpoint for initial admin creation - requires ADMIN_SECRET from env
router.post('/create-initial-admin', async (req, res) => {
  try {
    const { email, adminSecret } = req.body;
    
    if (adminSecret !== process.env.ADMIN_SECRET) {
       res.status(403).json({ message: 'Invalid admin secret' });
       return;
    }

    // Check if any admin already exists
    // const existingAdmin = await User.findOne({ role: 'admin' });

    // if (existingAdmin) {
    //    res.status(400).json({ message: 'Admin already exists' });
    //    return;
    // }

    // Create admin user
    const adminUser = await User.findOneAndUpdate(
      { email },
      { role: 'admin' },
      { new: true, upsert: true }
    );

    res.json({ message: 'Admin created successfully', user: adminUser });
  } catch (error) {
    res.status(500).json({ message: 'Error creating admin', error });
  }
});

// Protected endpoint for admins to update user roles
router.patch('/users/:userId/role', validateAuth0Token , async (req, res) => {
  try {
    const { role } = req.body;
    const { userId } = req.params;

    // Verify the requester is an admin
    // const requester = await User.findById(req.authInfo?.payload.sub);
    const requester = await User.findById(req.auth?.payload.sub);
    if (requester?.role !== 'admin') {
       res.status(403).json({ message: 'Only admins can update roles' });
       return;
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { role },
      { new: true }
    );

    res.json({ message: 'User role updated', user: updatedUser });
  } catch (error) {
    res.status(500).json({ message: 'Error updating user role', error });
  }
});

export default router; 