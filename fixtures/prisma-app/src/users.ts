import { prisma } from "./db";

export async function findUser(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export async function publishPost(id: number) {
  return prisma.post.update({ where: { id }, data: { published: true } });
}
