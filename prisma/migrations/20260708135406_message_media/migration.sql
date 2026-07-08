-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "mediaKey" TEXT,
ADD COLUMN     "mediaKind" TEXT,
ALTER COLUMN "text" SET DEFAULT '';
