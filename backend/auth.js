const express = require('express');
const router = express.Router();

const { WorkOS } = require('@workos-inc/node');
const cookieParser = require('cookie-parser');

const { SignJWT } = require('jose');
const { jwtVerify } = require('jose');


const secret = new Uint8Array(
    Buffer.from(process.env.JWT_SECRET_KEY, 'base64'),
  );

router.use(cookieParser());


const workos = new WorkOS(process.env.WORKOS_API_KEY);
const clientId = process.env.WORKOS_CLIENT_ID;


router.get('/logout', (req, res) => {
  res.clearCookie('token', {
    path: '/',
    secure: true, 
    httpOnly: true, 
    sameSite: 'None',
  });
  res.status(200).json({ message: 'Successfully logged out' });
});


router.get('/auth', (_req, res) => {
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',

    redirectUri: 'https://noisse-backend-production.up.railway.app/portal/callback',
    clientId,
  });

  // Redirect the user to the AuthKit sign-in page
  res.redirect(authorizationUrl);
});


router.get('/callback', async (req, res) => {

    const code = req.query.code;
  
    const { user } = await workos.userManagement.authenticateWithCode({
      code,
      clientId,
    });

    const token = await new SignJWT({
        user,
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secret);
    
      // Store in a cookie
      res.cookie('token', token, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      });

    res.redirect('https://noisse-frontend.vercel.app');
  });


router.get('/user', async (req, res) => {
  const token = req.cookies.token;

  if (!token) {
      return res.status(401).send({ isAuthenticated: false });
  }

  try {
      const verifiedToken = await jwtVerify(token, secret);

      // Check if verifiedToken and payload are defined
      if (verifiedToken && verifiedToken.payload) {
          res.status(200).send({
              isAuthenticated: true,
              user: verifiedToken.payload.user,
          });
      } else {
          // Handle case where verifiedToken or payload is undefined
          res.status(401).send({ isAuthenticated: false, user: null });
      }
  } catch {
      res.status(401).send({ isAuthenticated: false });
  }
});
