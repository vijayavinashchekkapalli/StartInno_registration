const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { invalidateDashboardCache, invalidateCachePrefixes } = require('../config/redis');
const { isValidEmail, sendUsernameEmail, sendPasswordResetEmail, sendTestEmail } = require('../config/mailer');

/**
 * Generate cryptographically secure token
 */
const generateResetToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const getConfiguredFrontendBaseUrl = () => {
  return process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://startinno-registration-1.onrender.com';
};

const handleMailerError = (res, error, fallbackMessage) => {
  const statusCode = error.statusCode || 500;
  console.error('[auth-mailer] error:', {
    message: error.message,
    code: error.code,
    response: error.response,
    statusCode
  });

  return res.status(statusCode).json({
    success: false,
    message: error.message || fallbackMessage,
    error: error.message || fallbackMessage
  });
};

exports.signup = async (req, res) => {
  try {
    const {
      username,
      firstName,
      middleName,
      lastName,
      email,
      phone,
      password,
      confirmPassword,
      collegeName,
      department,
      yearOfStudy,
      avatarUrl
    } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    
    // Validate required fields
    if (!firstName || !lastName || !email || !phone || !password) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    // Validate password confirmation (only if provided)
    if (password && confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    // Validate password strength
    if (password && password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    // Auto-generate username from email if not provided
    const generatedUsername = username || normalizedEmail.split('@')[0];

    // Use parallel queries to check for duplicates
    const [existingUsername, existingEmail, existingPhone] = await Promise.all([
      User.findOne({ username: generatedUsername }).lean(),
      User.findOne({ email: normalizedEmail }).lean(),
      User.findOne({ phone }).lean()
    ]);

    if (existingEmail) return res.status(400).json({ message: 'Email already registered' });
    if (existingUsername) return res.status(400).json({ message: 'Username already taken' });
    if (existingPhone) return res.status(400).json({ message: 'Phone number already registered' });

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = password ? await bcrypt.hash(password, salt) : '';

    // Create user
    const user = await User.create({
      username: generatedUsername,
      firstName,
      middleName: middleName || '',
      lastName,
      email: normalizedEmail,
      phone,
      collegeName: String(collegeName || '').trim(),
      department: String(department || '').trim(),
      yearOfStudy: String(yearOfStudy || '').trim(),
      avatarUrl: String(avatarUrl || '').trim(),
      password: hashedPassword
    });

    await invalidateDashboardCache();

    // Generate JWT token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        collegeName: user.collegeName || '',
        department: user.department || '',
        yearOfStudy: user.yearOfStudy || '',
        avatarUrl: user.avatarUrl || '',
        createdAt: user.createdAt,
        role: user.isAdmin ? 'Admin' : 'User'
      }
    });
  } catch (err) {
    console.error('[signup] error:', err.message);
    
    // Handle duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
      const normalizedField = String(field || '').toLowerCase();

      if (normalizedField === 'email' || String(err.message || '').toLowerCase().includes('email')) {
        return res.status(409).json({ message: 'Email already registered' });
      }

      if (normalizedField === 'phone') {
        return res.status(409).json({ message: 'Phone number already registered' });
      }

      if (normalizedField === 'username') {
        return res.status(409).json({ message: 'Username already taken' });
      }

      return res.status(409).json({ message: 'Account already exists' });
    }
    
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ message: 'Missing username/email or password' });
    }

    // Find user by username or email (NOT lean so we can use select)
    const user = await User.findOne({
      $or: [
        { username: identifier.toLowerCase() },
        { email: identifier.toLowerCase() },
        { phone: identifier }
      ]
    }).select('+password');

    if (!user) {
      console.log('[login] user not found for identifier:', identifier);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Verify password with proper error handling
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(password, user.password);
    } catch (bcryptErr) {
      console.error('[login] bcrypt error:', bcryptErr.message);
      return res.status(500).json({ success: false, message: 'Authentication error' });
    }

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

    console.log('[login] success for user:', user._id.toString());

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        collegeName: user.collegeName || '',
        department: user.department || '',
        yearOfStudy: user.yearOfStudy || '',
        avatarUrl: user.avatarUrl || '',
        createdAt: user.createdAt,
        role: user.isAdmin ? 'Admin' : 'User'
      }
    });
  } catch (err) {
    console.error('[login] error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

/**
 * Forgot Username - Send username to registered email
 */
exports.forgotUsername = async (req, res) => {
  try {
    const requestedEmail = String(req.body?.email || '').trim();

    if (!requestedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (!isValidEmail(requestedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const normalizedEmail = requestedEmail.toLowerCase();
    console.log('[auth-mailer] forgot username request received', {
      requestedEmail,
      normalizedEmail
    });

    const user = await User.findOne({ email: normalizedEmail }).lean();

    if (!user) {
      return res.status(200).json({
        success: true,
        message: 'If an account exists with this email, the username has been sent to your inbox.'
      });
    }

    try {
      await sendUsernameEmail(user.email, user.username, getConfiguredFrontendBaseUrl());
      console.log('[auth-mailer] forgot username email delivered successfully', {
        recipientEmail: user.email
      });

      return res.status(200).json({
        success: true,
        message: 'Username has been sent to your registered email address.'
      });
    } catch (mailError) {
      console.error('[auth-mailer] forgot username delivery failed', {
        requestedEmail,
        recipientEmail: user.email,
        message: mailError.message,
        code: mailError.code,
        response: mailError.response,
        statusCode: mailError.statusCode,
        stack: mailError.stack
      });

      return res.status(502).json({
        success: false,
        message: 'We could not send the username email right now. Please try again later.'
      });
    }
  } catch (err) {
    return handleMailerError(res, err, 'Failed to send username email');
  }
};

/**
 * Forgot Password - Generate reset token and send email
 */
exports.forgotPassword = async (req, res) => {
  try {
    const requestedEmail = String(req.body?.email || '').trim();

    if (!requestedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }

    if (!isValidEmail(requestedEmail)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    const normalizedEmail = requestedEmail.toLowerCase();
    console.log('[auth-mailer] forgot password request received', {
      requestedEmail,
      normalizedEmail
    });

    const user = await User.findOne({ email: normalizedEmail }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a password reset link has been sent to your inbox.'
      });
    }

    const resetToken = generateResetToken();
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetExpires = new Date(Date.now() + 15 * 60 * 1000);

    user.passwordResetToken = resetTokenHash;
    user.passwordResetExpires = resetExpires;
    await user.save();

    const baseUrl = getConfiguredFrontendBaseUrl();
    console.log('[auth-mailer] sending password reset email', {
      requestedEmail,
      recipientEmail: user.email,
      username: user.username
    });

    try {
      await sendPasswordResetEmail(user.email, resetToken, baseUrl, user.username);
      console.log('[auth-mailer] password reset email delivered successfully', {
        recipientEmail: user.email
      });

      return res.status(200).json({
        success: true,
        message: 'Password reset link has been sent to your registered email address.'
      });
    } catch (mailError) {
      console.error('[auth-mailer] forgot password delivery failed', {
        requestedEmail,
        recipientEmail: user.email,
        message: mailError.message,
        code: mailError.code,
        response: mailError.response,
        statusCode: mailError.statusCode,
        stack: mailError.stack
      });

      return res.status(502).json({
        success: false,
        message: 'We could not send the password reset email right now. Please try again later.'
      });
    }
  } catch (err) {
    return handleMailerError(res, err, 'Failed to send password reset email');
  }
};

/**
 * Reset Password - Verify token and update password
 */
exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password, confirmPassword } = req.body;

    if (!token) {
      return res.status(400).json({ message: 'Invalid reset token' });
    }

    if (!password || !confirmPassword) {
      return res.status(400).json({ message: 'Password and confirmation are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    // Hash the token for comparison
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with matching reset token and valid expiry
    const user = await User.findOne({
      passwordResetToken: resetTokenHash,
      passwordResetExpires: { $gt: new Date() }
    }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Update password and clear reset token
    user.password = hashedPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.'
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * Validate reset token
 */
exports.validateResetToken = async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    // Hash the token for comparison
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Check if token exists and is not expired
    const user = await User.findOne({
      passwordResetToken: resetTokenHash,
      passwordResetExpires: { $gt: new Date() }
    }).select('+passwordResetToken +passwordResetExpires');

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    res.status(200).json({
      success: true,
      message: 'Token is valid. Proceed to reset password.'
    });
  } catch (err) {
    console.error('Token validation error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

exports.testMail = async (req, res) => {
  try {
    const recipient = process.env.EMAIL_USER;

    if (!recipient || !isValidEmail(recipient)) {
      return res.status(500).json({ success: false, message: 'EMAIL_USER is not configured correctly' });
    }

    const info = await sendTestEmail(recipient, { waitForDelivery: true });

    return res.status(200).json({
      success: true,
      message: 'Test email sent successfully',
      messageId: info.messageId
    });
  } catch (err) {
    return handleMailerError(res, err, 'Failed to send test email');
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        registrationId: user._id,
        username: user.username,
        firstName: user.firstName || '',
        middleName: user.middleName || '',
        lastName: user.lastName || '',
        fullName: [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' ').trim(),
        email: user.email || '',
        phone: user.phone || '',
        collegeName: user.collegeName || '',
        department: user.department || '',
        yearOfStudy: user.yearOfStudy || '',
        avatarUrl: user.avatarUrl || '',
        role: user.isAdmin ? 'Admin' : 'User',
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('[getMyProfile] error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const {
      firstName,
      middleName,
      lastName,
      phone,
      collegeName,
      department,
      yearOfStudy,
      avatarUrl
    } = req.body;

    const updates = {
      ...(typeof firstName === 'string' ? { firstName: firstName.trim() } : {}),
      ...(typeof middleName === 'string' ? { middleName: middleName.trim() } : {}),
      ...(typeof lastName === 'string' ? { lastName: lastName.trim() } : {}),
      ...(typeof phone === 'string' ? { phone: phone.trim() } : {}),
      ...(typeof collegeName === 'string' ? { collegeName: collegeName.trim() } : {}),
      ...(typeof department === 'string' ? { department: department.trim() } : {}),
      ...(typeof yearOfStudy === 'string' ? { yearOfStudy: yearOfStudy.trim() } : {}),
      ...(typeof avatarUrl === 'string' ? { avatarUrl: avatarUrl.trim() } : {})
    };

    const updatedUser = await User.findByIdAndUpdate(userId, updates, {
      new: true,
      runValidators: true
    }).lean();

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await invalidateCachePrefixes([`user:me:`]);

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: updatedUser._id,
        firstName: updatedUser.firstName || '',
        middleName: updatedUser.middleName || '',
        lastName: updatedUser.lastName || '',
        fullName: [updatedUser.firstName, updatedUser.middleName, updatedUser.lastName].filter(Boolean).join(' ').trim(),
        email: updatedUser.email || '',
        phone: updatedUser.phone || '',
        collegeName: updatedUser.collegeName || '',
        department: updatedUser.department || '',
        yearOfStudy: updatedUser.yearOfStudy || '',
        avatarUrl: updatedUser.avatarUrl || '',
        role: updatedUser.isAdmin ? 'Admin' : 'User',
        createdAt: updatedUser.createdAt
      }
    });
  } catch (error) {
    console.error('[updateMyProfile] error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
};

exports.changeMyPassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All password fields are required' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long' });
    }

    const user = await User.findById(userId).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();
    await invalidateCachePrefixes([`user:me:`]);

    return res.status(200).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('[changeMyPassword] error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to change password' });
  }
};

