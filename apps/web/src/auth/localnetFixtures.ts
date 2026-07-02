export const localnetAllowedDomains = ['send.it'] as const
export const localnetAdminEmails = ['admin@send.it'] as const

export const localnetUsers = {
  owner: {
    email: 'owner@send.it',
    password: 'localnet-owner-password',
    name: 'Owner User',
  },
  secondUser: {
    email: 'second@send.it',
    password: 'localnet-second-password',
    name: 'Second User',
  },
  wrongDomain: {
    email: 'wrong@example.com',
    password: 'localnet-wrong-domain-password',
    name: 'Wrong Domain User',
  },
  external: {
    email: 'external@example.net',
    password: 'localnet-external-password',
    name: 'External User',
  },
  admin: {
    email: 'admin@send.it',
    password: 'localnet-admin-password',
    name: 'Admin User',
  },
} as const
