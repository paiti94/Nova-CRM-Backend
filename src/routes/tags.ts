// routes/tags.ts
import express from 'express';
import Tag from '../models/Tags';

const router = express.Router();

router.get('/', async (req, res) => {
  const tags = await Tag.find();
  res.json(tags);
});

router.post('/', async (req, res) => {
  const { value, label } = req.body;

  const exists = await Tag.findOne({ value });
  if (exists)  res.status(409).json({ message: 'Tag already exists' });

  const newTag = new Tag({ value, label });
  await newTag.save();
res.status(201).json(newTag);
});

export default router;
