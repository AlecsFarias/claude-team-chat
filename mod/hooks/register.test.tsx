import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'team-chat',
  props: {
    title: 'Chat',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
  viewport: { columns: 80, rows: 40 },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`chat, members, groups, contacts and profile on ${surface}`, async $ => {
    const ui = await $.ui.mount({ plugin: 'team-chat', surface, ...PANE })
    const has = async (text: RegExp) => {
      const found = await ui.find({ type: 'Text', text })
      if (!found) {
        const drawn = (await ui.findAll({ type: 'Text' })).map(one => one.text).join(' | ')
        throw new Error(`${surface}: ${text} not drawn in: ${drawn}`)
      }
    }

    // App header and chat header.
    await has(/Alecsander Farias/)
    await has(/# geral · 5 membros/)
    await has(/bom dia, pessoal/)

    // Sending appends and clears the field.
    await ui.input({ key: 'composer', text: `olá de ${surface}` })
    await has(new RegExp(`olá de ${surface}`))

    // Members of the chat.
    await ui.press({ key: 'show-members' })
    await has(/Diego Rocha/)
    await ui.press({ key: 'back' })

    // Groups: create one and land in it.
    await ui.press({ key: 'nav-groups' })
    await has(/# ajuda/)
    await ui.input({ key: 'new-group', text: `time ${surface}` })
    await has(new RegExp(`# time ${surface} · 1 membros`))

    // Contacts: add one, open a DM.
    await ui.press({ key: 'nav-contacts' })
    await ui.input({ key: 'new-contact', text: `Zé ${surface}` })
    await has(new RegExp(`Zé ${surface}`))
    await ui.press({ key: 'contact-carla' })
    await has(/@ Carla Mendes/)

    // Profile placeholder.
    await ui.press({ key: 'nav-profile' })
    await has(/em breve/)
    await ui.press({ key: 'back' })

    await ui.unmount()
  })
}
