import prisma from '~lib/prisma'
import logger from '~lib/logger'
import { profile_client } from '~slack/lib/profile'
import { slack_client } from '~slack'
import { getManagers } from '~lib/cert_operations'

let timeout: NodeJS.Timeout

export function scheduleUpdateSlackUsergroups() {
    if (timeout) {
        timeout.refresh()
    } else {
        timeout = setTimeout(updateSlackUsergroups, 1000 * 30)
    }
}

export async function updateSlackUsergroups() {
    if (profile_client == null) {
        return
    }
    const usergroups_list = await slack_client.usergroups.list({ include_disabled: true })
    const usergroups = new Map(usergroups_list.usergroups!.map((g) => [g.id!, g]))
    const departments = await prisma.department.findMany({ include: { Members: { select: { Member: { select: { slack_id: true } } } } } })
    const syncUsergroup = async (data: { department_id: string; group_id: string | null; title: string; handle: string; member_ids: string[] }) => {
        const existing = usergroups.get(data.group_id ?? '')
        let returnValue: { group_id: string; isNew: boolean }
        if (data.group_id == null || existing == null) {
            const resp = await profile_client!.usergroups
                .create({
                    name: data.title,
                    handle: data.handle
                })
                .catch((e) => {
                    return { usergroup: null, error: e }
                })
            if (resp.error != null) {
                logger.error({ error: resp.error, department: data.department_id, handle: data.handle }, 'Could not create usergroup')
                return
            } else {
                data.group_id = resp.usergroup!.id!
                returnValue = { group_id: resp.usergroup!.id!, isNew: true }
            }
        } else {
            if (existing.name != data.title || existing.handle != data.handle) {
                await profile_client!.usergroups.update({
                    usergroup: data.group_id,
                    name: data.title,
                    handle: data.handle
                })
            }
            returnValue = { group_id: data.group_id, isNew: false }
        }

        if (data.member_ids.length == 0 && existing != null) {
            // If it's already disabled, don't disable it again
            if (!existing.date_delete) {
                await profile_client!.usergroups.disable({
                    usergroup: data.group_id
                })
            }
        }

        if (data.member_ids.length > 0) {
            if (existing?.date_delete) {
                await profile_client!.usergroups.enable({
                    usergroup: data.group_id
                })
            }
            await profile_client!.usergroups.users.update({
                usergroup: data.group_id,
                users: data.member_ids.join(',')
            })
        }

        return returnValue
    }
    for (const department of departments) {
        const res = await syncUsergroup({
            department_id: department.id,
            group_id: department.slack_group,
            title: department.name,
            handle: department.name.toLowerCase().replace(' ', '-') + '-dept',
            member_ids: department.Members.filter((m) => m.Member.slack_id != null).map((m) => m.Member.slack_id!)
        })
        if (res?.isNew) {
            await prisma.department.update({
                where: { id: department.id },
                data: {
                    slack_group: res.group_id
                }
            })
        }
    }
    for (const manager_department of await getManagers()) {
        const department = manager_department.dept
        const res = await syncUsergroup({
            department_id: department.id,
            group_id: department.manager_slack_group,
            title: department.name + ' Managers',
            handle: department.name.toLowerCase().replace(' ', '-') + '-managers',
            member_ids: manager_department.managers
        })
        if (res?.isNew) {
            await prisma.department.update({
                where: { id: department.id },
                data: {
                    manager_slack_group: res.group_id
                }
            })
        }
    }
}
