import { prisma } from "@/lib/prisma";

export function getParties() {
  return prisma.party.findMany({ orderBy: { name: "asc" } });
}
