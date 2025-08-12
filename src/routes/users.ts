import express, { RequestHandler, Router } from 'express';
import { ManagementClient } from 'auth0';
import { validateAuth0Token, attachUser } from '../middleware/auth';
import User from '../models/User';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { FolderService } from '../services/folderService';

const router: Router = express.Router();

const auth0Management = new ManagementClient({
  domain: process.env.AUTH0_DOMAIN!,
  clientId: process.env.AUTH0_MANAGEMENT_CLIENT_ID!,
  clientSecret: process.env.AUTH0_MANAGEMENT_CLIENT_SECRET!,
});

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

// Create separate routers
const publicRouter = express.Router();
const protectedRouter = express.Router();

// Public route for admin setup
publicRouter.post('/init-admin', async (req, res) => {
  try {
    const { email, name, password, setupPassword } = req.body;
    
    // Check setup password
    if (setupPassword !== process.env.ADMIN_SETUP_PASSWORD) {
      res.status(403).json({ error: 'Invalid setup password' });
      return;
    }

    // Generate avatar
    const avatar = generateInitialsAvatar(name);

    // Create user in Auth0 (without picture)
    const userInAuth0 = await auth0Management.users.create({
      connection: 'Username-Password-Authentication',
      email,
      password,
      name,
      email_verified: true,
      // Remove picture property
    });

    // Create user in MongoDB with avatar
    const user = await User.create({
      email,
      name,
      role: 'admin',
      auth0Id: userInAuth0.data.user_id,
      status: 'active',
      avatar, // Store avatar in MongoDB only
    });

    await FolderService.createDefaultFolders(user);

    res.status(201).json({
      message: 'Admin user created successfully',
      email: user.email
    });

  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).json({ error: 'Failed to create admin user' });
  }
});

// Protected routes
protectedRouter.use(validateAuth0Token);
protectedRouter.use(attachUser as RequestHandler);

// Get all users
protectedRouter.get('/', async (req, res) => {
    try {
      const users = await User.find().select('-auth0Id');
      res.json(users);
    } catch (error) {
      res.status(500).json({ message: 'Error fetching users' });
    }
  });
  
  // Update user profile
  protectedRouter.patch('/profile', async (req, res) => {
    try {
      const updates = {
        name: req.body.name,
        phoneNumber: req.body.phoneNumber,
        company: req.body.company,
        position: req.body.position,
        updatedAt: new Date(),
      };
  
      const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true });
      
      res.json(user);
      return;
    } catch (error) {
        res.status(500).json({ message: 'Error updating profile' });
        return;
    }
  });
  
  // protectedRouter.get('/me', async (req, res) => {
  //   try {
  //     const user = await User.findById(req.user._id).select('-password');
  //     if (!user) {
  //        res.status(404).json({ message: 'User not found' });
  //        return;
  //     }
  //     res.json(user);
  //     console.log(user);
  //   } catch (error) {
  //     res.status(500).json({ message: 'Error fetching user data' });
  //   }
  // });

  protectedRouter.get('/me', async (req, res) => {
    try {
      // base user document (thanks to toJSON transform and select:false, tokens won't serialize)
      const baseUser = await User.findById(req.user._id)
        .select('-password -auth0Id')
        .lean();
  
      if (!baseUser) {
        res.status(404).json({ message: 'User not found' });
        return;
      }
  
      // check connection using a separate query that explicitly selects hidden fields
      const tokenDoc = await User.findById(req.user._id)
        .select('+msTokens.access_token')
        .lean();
  
      const msConnected = !!tokenDoc?.msTokens?.access_token;
  
      res.json({ ...baseUser, msConnected }); // <-- boolean only
    } catch (error) {
      console.error('Error fetching user data:', error);
      res.status(500).json({ message: 'Error fetching user data' });

      
    }
  });

  protectedRouter.get('/admin', async(req, res)=>{
    try{
      const adminList = await User.find({ role: 'admin' });
      if (adminList.length === 0) {
         res.status(404).json({ message: 'No admin users found' });
         return;
      }
      res.json(adminList);
    } catch (error) {
      console.error('Error fetching admin users:', error);
      res.status(500).json({ message: 'Error fetching admin users' });
    }
  });

  protectedRouter.patch('/tags', async (req, res) => {
    const { id, tags } = req.body;
    try {
      await User.findByIdAndUpdate(new mongoose.Types.ObjectId(id as string), { tags });
  
      res.status(200).json({ message: 'User tags updated successfully' });
    } catch (error) {
      console.error('Error updating user tags:', error);
      res.status(500).json({ message: 'Error updating user tags' });
    }
  });

  // server/src/routes/users.ts
protectedRouter.patch('/role', async (req, res) => {
  const { id, role } = req.body;
  try {
    // await auth0ManagementClient.updateUser({ id }, { app_metadata: { role } });

    await User.findByIdAndUpdate(new mongoose.Types.ObjectId(id as string), { role });

    res.status(200).json({ message: 'User role updated successfully' });
  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ message: 'Error updating user role' });
  }
});

protectedRouter.post('/invite', async (req, res) => {
  try {
    const { email, name, company, phone, role } = req.body;
    const tempPassword = crypto.randomBytes(6).toString('base64') + 'A1!';
    
    // Generate avatar
    const avatar = generateInitialsAvatar(name);

    // Create user in Auth0 (without picture)
    const userInAuth0 = await auth0Management.users.create({
      connection: 'Username-Password-Authentication',
      email,
      email_verified: false,
      password: tempPassword,
      name,
      // Remove picture property
    });

    // Create user in MongoDB with avatar
    const user = await User.create({
      email,
      name,
      company,
      phone,
      role,
      status: 'pending',
      auth0Id: userInAuth0.data.user_id,
      avatar, // Store avatar in MongoDB only
    });

    await FolderService.createDefaultFolders(user);

    // Step 3: Generate password setup ticket
    const ticketRes = await auth0Management.tickets.changePassword({
      user_id: userInAuth0.data.user_id,
      result_url: `${process.env.CLIENT_URL}/auth/verified`,  // Use full URL
      ttl_sec: 86400,
      mark_email_as_verified: true,
      includeEmailInRedirect: true
    });

    const inviteUrl = ticketRes.data.ticket;
    res.json({ inviteUrl });

  } catch (error) {
    console.error('Error creating invitation:', error);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

// Modify the delete endpoint to also remove from Auth0
protectedRouter.delete('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
       res.status(404).json({ error: 'User not found' });
    }else{
      if (user.auth0Id) {
        await auth0Management.users.delete({ id: user.auth0Id });
      }
    }
    // Delete from your database
    await User.findByIdAndDelete(req.params.id);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Combine routers
router.use(publicRouter);  // Public routes first
router.use(protectedRouter);  // Protected routes second

export default router;