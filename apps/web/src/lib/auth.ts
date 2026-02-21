import { compare } from "bcryptjs";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { authBypassed, authRequired, getAllowedEmail } from "@/lib/auth-constants";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (authRequired()) {
    throw new Error(`${name} is required when authentication is enabled`);
  }
  return "local-bypass";
}

function parseCredentials(input: Record<string, unknown> | undefined) {
  const email = String(input?.email ?? "").trim().toLowerCase();
  const password = String(input?.password ?? "");
  return { email, password };
}

export const authOptions: NextAuthOptions = {
  secret: requiredEnv("NEXTAUTH_SECRET"),
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Brain Dock Login",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (authBypassed()) {
          return {
            id: "local-bypass",
            email: getAllowedEmail(),
            name: "Local Bypass User",
          };
        }

        const { email, password } = parseCredentials(credentials);
        const allowedEmail = getAllowedEmail();
        if (!email || !password || email !== allowedEmail) {
          return null;
        }

        const passwordHash = requiredEnv("BRAIN_DOCK_PASSWORD_BCRYPT");
        const validPassword = await compare(password, passwordHash);
        if (!validPassword) {
          return null;
        }

        return {
          id: allowedEmail,
          email: allowedEmail,
          name: "Brain Dock User",
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (authBypassed()) {
        return true;
      }
      const email = (user.email ?? "").toLowerCase();
      return email === getAllowedEmail();
    },
    async jwt({ token, user }) {
      const email = (user?.email ?? token.email ?? "").toLowerCase();
      token.email = email;
      token.allowed = email === getAllowedEmail();
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = typeof token.email === "string" ? token.email : session.user.email;
      }
      return session;
    },
  },
};
