import { Context, Hono } from 'hono'
import { syncSlackMembers } from '~tasks/slack'
import { APIClockExternalRespondRequest, APIClockExternalSubmitRequest, APIClockLabRequest, APIClockResponse, APIMember } from '~types'
import logger from '~lib/logger'
import { requireReadAPI, requireWriteAPI } from '~lib/auth'
import { emitCluckChange } from '~lib/sockets'
import prisma, { getMemberPhotoOrDefault } from '~lib/prisma'
import { cors } from 'hono/cors'
import { completeHourLog } from '~lib/hour_operations'
import { router as admin_api_router } from './admin'

const router = new Hono()

router.route('/', admin_api_router)
router.get('/members', requireReadAPI, async (c) => {
    const members = await prisma.member.findMany({
        select: {
            email: true,
            first_name: true,
            full_name: true,
            use_slack_photo: true,
            slack_photo: true,
            slack_photo_small: true,
            fallback_photo: true
        },
        where: {
            active: true
        },
        orderBy: { full_name: 'asc' }
    })
    const resp: APIMember[] = members.map((member) => ({
        email: member.email,
        first_name: member.first_name,
        full_name: member.full_name,
        photo: getMemberPhotoOrDefault(member, false),
        photo_small: getMemberPhotoOrDefault(member, true)
    }))
    return c.json(resp)
})

router.get('/members/refresh', requireReadAPI, async (c) => {
    await syncSlackMembers()
    return c.redirect('/api/members', 302)
})

router.use('/members/fallback_photos', cors({ origin: ['https://portals.veracross.com'] }))
router.post('/members/fallback_photos', requireWriteAPI, async (c) => {
    logger.info('Updating fallback photos')
    const body: Record<string, string> = await c.req.json()
    await prisma.fallbackPhoto.deleteMany({})
    const { count } = await prisma.fallbackPhoto.createMany({ data: Object.entries(body).map(([k, v]) => ({ email: k.toLowerCase(), url: v })) })
    const members = await prisma.member.findMany({ select: { email: true } })
    for (const member of members) {
        await prisma.member.update({ where: { email: member.email }, data: { fallback_photo: body[member.email] } })
    }
    return c.text(`Updated ${count} fallback photos`)
})
function clockJson(c: Context, payload: APIClockResponse) {
    return c.json(payload)
}

router
    .post('/clock/lab', requireWriteAPI, async (c) => {
        const { email, action }: APIClockLabRequest = await c.req.json()
        const member = await prisma.member.findUnique({ where: { email }, select: { email: true } })
        if (member == null) {
            logger.warn('ignoring login for unknown user ' + email)
            c.status(400)
            return clockJson(c, { success: false, error: 'member unknown' })
        }
        try {
            const log = await prisma.hourLog.findFirst({ where: { state: 'pending', type: 'lab', member_id: email } })
            if (log) {
                if (action == 'in') {
                    logger.warn('ignoring duplicate login for ' + email)
                    return clockJson(c, { success: false, error: 'member already logged in', log_id: log.id })
                }
                if (action == 'out') {
                    await completeHourLog(email, false)
                } else if (action == 'void') {
                    await completeHourLog(email, true)
                }

                return clockJson(c, { success: true, log_id: log.id })
            } else if (action == 'in') {
                const newLog = await prisma.hourLog.create({
                    data: {
                        member_id: email,
                        time_in: new Date(),
                        type: 'lab',
                        state: 'pending'
                    }
                })
                emitCluckChange({ email, logging_in: true })
                return clockJson(c, { success: true, log_id: newLog.id })
            } else {
                c.status(400)
                return clockJson(c, { success: false, error: 'member not signed in' })
            }
        } catch (e) {
            logger.error(e)
            c.status(500)
            return clockJson(c, { success: false, error: 'unknown' })
        }
    })
    .get(async (c) => {
        const records = await prisma.hourLog.findMany({
            where: { state: 'pending', type: 'lab' },
            select: { id: true, member_id: true, time_in: true }
        })
        return c.json(records.map(({ id, member_id, time_in }) => ({ id, time_in, email: member_id })))
    })

router.get('/clock/external', requireReadAPI, async (c) => {
    const records = await prisma.hourLog.findMany({
        where: { state: 'pending', type: 'external' },
        select: { id: true, member_id: true, time_in: true, duration: true, slack_ts: true, message: true }
    })
    return c.json(records.map(({ id, member_id, time_in }) => ({ id, time_in, email: member_id })))
})

router.post('/clock/external/submit', requireWriteAPI, async (c) => {
    const { email, message, hours }: APIClockExternalSubmitRequest = await c.req.json()
    const member = await prisma.member.findUnique({ where: { email }, select: { email: true } })
    if (member == null) {
        logger.warn('ignoring external submission for unknown user ' + email)
        c.status(400)
        return c.json({ success: false, error: 'member unknown' })
    }
    try {
        const newLog = await prisma.hourLog.create({
            data: {
                member_id: email,
                time_in: new Date(),
                duration: hours,
                message,
                type: 'external',
                state: 'pending'
            }
        })
        return clockJson(c, { success: true, log_id: newLog.id })
    } catch (e) {
        logger.error(e)
        c.status(500)
        return clockJson(c, { success: false, error: 'unknown' })
    }
})

router.post('/clock/external/respond', requireWriteAPI, async (c) => {
    const { id, action, category }: APIClockExternalRespondRequest = await c.req.json()
    const log = await prisma.hourLog.findUnique({ where: { id } })
    if (log == null) {
        logger.warn('Ignoring confirmation for unknown hour request ' + id)
        c.status(400)
        return clockJson(c, { success: false, error: 'request unknown' })
    }
    if (log.state != 'pending') {
        logger.warn('Received confirmation for completed hour request ' + id + '. Updating anyway...')
    }
    try {
        if (action == 'approve') {
            await prisma.hourLog.update({
                where: { id: log.id },
                data: {
                    time_out: new Date(),
                    state: 'complete',
                    type: category
                }
            })
        } else {
            await prisma.hourLog.update({
                where: { id: log.id },
                data: {
                    time_out: new Date(),
                    state: 'cancelled'
                }
            })
        }
        return clockJson(c, { success: true, log_id: log.id })
    } catch (e) {
        logger.error(e)
        c.status(500)
        return clockJson(c, { success: false, error: 'unknown' })
    }
})
export default router