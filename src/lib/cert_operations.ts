import { Cert, Prisma } from '@prisma/client'
import { Blocks, Elements, Message } from 'slack-block-builder'
import prisma from '~lib/prisma'
import { slack_client } from '~slack'
import config from '~config'
import { ActionIDs } from '~slack/handlers'
import { getCertRequestMessage } from '~slack/messages/certify'

enum CertOperationsError {
    CERT_NOT_FOUND = 'This cert cannot be found',
    CERT_NOT_MANAGED = "This cert can't be given by managers",
    USER_NOT_MANAGER = 'You are not a manager for this cert',
    USER_NOT_FOUND = 'User not found'
}
export async function canGiveCert(
    user: Prisma.MemberWhereUniqueInput,
    cert: { managerCert: string | null }
): Promise<
    | {
          success: true
      }
    | { success: false; error: CertOperationsError }
> {
    if (cert.managerCert == null) {
        return { success: false, error: CertOperationsError.CERT_NOT_MANAGED }
    }
    const managecert = await prisma.memberCert.findFirst({
        where: {
            Member: user,
            cert_id: cert.managerCert
        }
    })

    if (managecert == null) {
        return { success: false, error: CertOperationsError.USER_NOT_MANAGER }
    }
    return { success: true }
}

export async function createCertRequest(giver: Prisma.MemberWhereUniqueInput, recipient_slack_ids: string[], cert_id: Prisma.CertWhereUniqueInput) {
    const cert = await prisma.cert.findUnique({ where: cert_id, select: { id: true, managerCert: true, replaces: true, label: true } })
    if (!cert) {
        return { success: false, error: CertOperationsError.CERT_NOT_FOUND }
    }
    const canGive = await canGiveCert(giver, cert)
    if (!canGive.success) {
        return canGive
    }

    const giving_member = await prisma.member.findUnique({ where: giver })
    if (!giving_member) {
        return { success: false, error: CertOperationsError.USER_NOT_FOUND }
    }
    const recipients = await prisma.member.findMany({
        select: { email: true, MemberCerts: { where: { cert_id: cert.id }, select: { cert_id: true } } },
        where: { slack_id: { in: recipient_slack_ids } }
    })
    if (recipients.length != recipient_slack_ids.length) {
        return { success: false, error: CertOperationsError.USER_NOT_FOUND }
    }
    setTimeout(async () => {
        // Do in separate event loop to avoid blocking the request
        const resp = await prisma.memberCertRequest.createManyAndReturn({
            data: recipients
                .filter((r) => r.MemberCerts.length == 0) // Only request certs for members who don't already have it
                .map((member) => ({
                    requester_id: giving_member.email,
                    member_id: member.email,
                    cert_id: cert.id,
                    state: 'pending'
                })),
            select: { id: true, Member: { select: { slack_id: true, slack_photo_small: true, fallback_photo: true, full_name: true } } }
        })
        for (const r of resp) {
            const msg = await slack_client.chat.postMessage(getCertRequestMessage(giving_member, r, cert, 'pending'))
            await prisma.memberCertRequest.update({ where: { id: r.id }, data: { slack_ts: msg.ts } })
        }
    })
    return { success: true }
}
