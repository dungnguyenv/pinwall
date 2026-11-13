# Sign-in

Who can sign in to Pinwall, and as what: the built-in owner account, and single sign-on through an
OpenID Connect provider, with tested recipes for Zitadel, Keycloak and Google, and how to let anyone
the provider signs in become a member.

- [Zitadel](#zitadel)
- [Keycloak](#keycloak)
- [Google](#google)
- [Open sign-up](#open-sign-up)

The built-in **owner account** needs no identity provider. You create it with the setup link from
[the first start](install.md#docker), with a passkey or a password, and it is always an admin.
Everyone else signs in through an OpenID Connect provider, once you set `PINWALL_OIDC_ISSUER` and
`PINWALL_OIDC_CLIENT_ID`. Single sign-on stays off while neither is set. Setting only one of them,
or a client secret without them, stops Pinwall at startup with a message that names what is missing.

Pinwall does not manage groups. It reads them from the provider and maps them to two roles, admin
and member. Group rules read the claim that `PINWALL_OIDC_ROLES_CLAIM` names, and Pinwall refuses to
start with group rules but no such claim. At the provider, register Pinwall with this redirect URI,
which is your public origin plus `/auth/oidc/callback`:

```text
https://pinwall.example/auth/oidc/callback
```

Also register this post-logout redirect URI, so that **Use a different account** works when someone
who signed in has no access to Pinwall: Pinwall signs them out at the provider first, then the
provider asks again who is signing in. A provider that does not allow the address shows its own
error page instead.

```text
https://pinwall.example/auth/oidc/signed-out
```

By default Pinwall asks for the scopes `openid email profile offline_access`. The refresh token
that `offline_access` brings lets it check again, every `PINWALL_ACCESS_RECHECK_INTERVAL` (12 hours
by default, never more than 24), that someone still has access. A person removed at the provider
loses access by the next check, with no admin action, and an admin can end a person's browser
sessions, MCP tokens and API tokens with **Revoke now** under **Admin, Users**. Their next request
is refused. A live-update stream they already have open, such as a review page left open, is
checked again within 25 seconds, and until then it can still bring them new comments. Revoke now,
a block, or a check that finds the provider gives someone no role also revokes every share link that
person made, for good. Their links also stop opening whenever their own access lapses, for instance
when a check is overdue or the provider refused it, and open again once they sign in.

Put the client secret in a file and give its path in `PINWALL_OIDC_CLIENT_SECRET_FILE`. A person who
signs in successfully but earns no role is refused. A role an admin sets on the Users page replaces
the provider's only while the provider still lets the person in: once it drops them they lose access
like anyone else, and the role applies again if it takes them back. A block always applies.

## Zitadel

1. In your Zitadel project, add the roles `pinwall-admin` and `pinwall-member`, switch on **Assert
   Roles on Authentication** in the project's settings, and give each person one of the roles.
2. Add an application of type **Web** that uses the code flow, with the grant types **Authorization
   Code** and **Refresh Token**, the redirect URI `https://pinwall.example/auth/oidc/callback`
   and the post logout URI `https://pinwall.example/auth/oidc/signed-out`.
   Copy the client id, and the client secret if you chose a method that has one.
3. Give Pinwall these variables. The roles arrive in a claim whose keys are the role names.

```sh
PINWALL_OIDC_ISSUER=https://zitadel.example
PINWALL_OIDC_CLIENT_ID=<client id>
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Zitadel
PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles
PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin
PINWALL_OIDC_MEMBER_GROUPS=pinwall-member
```

## Keycloak

1. Create a client of type OpenID Connect with **Client authentication** on, so that it is
   confidential, and with the standard flow only. Add the redirect URI
   `https://pinwall.example/auth/oidc/callback`, and set the advanced setting **Proof Key for Code
   Exchange Code Challenge Method** to `S256`. Under **Valid post logout redirect URIs**, add
   `https://pinwall.example/auth/oidc/signed-out`. The client secret is on its **Credentials** tab.
2. Create two groups, for example `pinwall-admins` and `pinwall-members`, and put people in them.
3. Under the client's dedicated scope, add a mapper of type **Group Membership** named `groups`,
   with the token claim name `groups`, **Full group path** off, and the claim added to the ID
   token and to the userinfo response. With the full path on, a group arrives as `/pinwall-admins`,
   which does not match the name you give Pinwall.
4. Pinwall asks for `offline_access`. Keycloak allows it for a new client, and for people who keep
   the realm's default roles.

```sh
PINWALL_OIDC_ISSUER=https://keycloak.example/realms/main
PINWALL_OIDC_CLIENT_ID=pinwall
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Keycloak
PINWALL_OIDC_ROLES_CLAIM=groups
PINWALL_OIDC_ADMIN_GROUPS=pinwall-admins
PINWALL_OIDC_MEMBER_GROUPS=pinwall-members
```

Pinwall's own CI signs in through a real Keycloak 26 set up exactly like this, with an admin, a
member and a person in no group.

## Google

Google has no groups claim, and it refuses the `offline_access` scope. Pinwall therefore takes
roles from lists of verified email addresses, and asks for a refresh token the way Google wants it.

1. In the Google Cloud console, create an OAuth client of type **Web application** and add
   `https://pinwall.example/auth/oidc/callback` as an authorized redirect URI.
2. Give Pinwall these variables:

```sh
PINWALL_OIDC_ISSUER=https://accounts.google.com
PINWALL_OIDC_CLIENT_ID=<client id>.apps.googleusercontent.com
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Google
PINWALL_OIDC_SCOPES=openid email profile
PINWALL_OIDC_EXTRA_AUTH_PARAMS=access_type=offline&prompt=consent
PINWALL_ADMIN_EMAILS=you@example.com
PINWALL_MEMBER_DOMAINS=example.com
PINWALL_MEMBER_EMAILS=friend@gmail.com
```

`PINWALL_ADMIN_EMAILS` makes those addresses admins. `PINWALL_MEMBER_DOMAINS` makes every
address in those domains a member, and `PINWALL_MEMBER_EMAILS` adds single addresses. Only an
address that Google reports as verified counts. Set at least one member list: when none of the
member groups, emails and domains is set, Pinwall makes everyone that Google signs in a member,
and any Google account can sign in. That is what an [open instance](#open-sign-up) wants, and
nothing else should.

## Open sign-up

An open instance lets anyone the provider signs in become a member. Pinwall does this without a
setting of its own: when no member group, email or domain rule is set, everyone the provider admits
is a member, and the admin rules still make admins. A person you block stays blocked. The rest of
the setup, such as quotas and who may share pages, is in
[Running an open instance](open-instance.md).

- **Use it only with `PINWALL_VISIBILITY=personal`,** where each person sees just their own
  projects. In `team` mode Pinwall logs a warning at startup, because everyone the provider signs in
  would see every project.
- **A person whose token has no roles claim is admitted as a member.** The access re-check does not
  count a missing claim as a removal either.
- **The warning "a sign-in token had no roles claim" appears only when a member group rule exists.**
  Without one, a missing claim is normal.

### Zitadel with Google

1. Give Pinwall's people an organization of their own in Zitadel. Set its login policy so that
   Google is the only way in: Google added as an identity provider of the organization, with new
   accounts created on first sign-in, and no username and password.
2. In the Zitadel project, add the role `pinwall-admin`, switch on **Assert Roles on
   Authentication**, and give the role to the admins. Nobody else needs a role, because a person
   with none is a member. Leave off any project setting that requires a role to sign in, since a new
   person has none.
3. Register the application as in [Zitadel](#zitadel) above, with the same redirect URIs and grant
   types.
4. Add the scope `urn:zitadel:iam:org:id:<organization id>` to Pinwall's scopes. It keeps sign-in
   to that organization, so its login policy is the one that applies. Optionally add
   `urn:zitadel:iam:org:idp:id:<Google IdP id>`, which sends the person straight to Google, without
   a login page in between.
5. Give Pinwall these variables, with no member rule. The scope list replaces the default one, so
   it repeats the default scopes:

```sh
PINWALL_OIDC_ISSUER=https://zitadel.example
PINWALL_OIDC_CLIENT_ID=<client id>
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Google
PINWALL_OIDC_SCOPES=openid email profile offline_access urn:zitadel:iam:org:id:<organization id>
PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles
PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin
```

### Google directly

Set Google up as in [Google](#google) above, and give Pinwall only the admin list. On the OAuth
consent screen, choose the external user type and publish the app: while it is in testing, Google
lets in only the test users you list.

```sh
PINWALL_OIDC_ISSUER=https://accounts.google.com
PINWALL_OIDC_CLIENT_ID=<client id>.apps.googleusercontent.com
PINWALL_OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc-client-secret
PINWALL_OIDC_DISPLAY_NAME=Google
PINWALL_OIDC_SCOPES=openid email profile
PINWALL_OIDC_EXTRA_AUTH_PARAMS=access_type=offline&prompt=consent
PINWALL_ADMIN_EMAILS=you@example.com
```

Only an address that Google reports as verified makes an admin. Every other Google account that
signs in is a member.

### Order of operations

This order holds for any instance that already has people and work on it:

1. **Deploy 1.1 in personal mode while the member rule still holds.** Set
   `PINWALL_VISIBILITY=personal`, and the quota and approval settings from
   [Settings](open-instance.md#settings), and restart.
2. **Move the existing work with `pinwall transfer`,** and check that a second account sees none of
   it. [Moving work between people](open-instance.md#moving-work-between-people) shows how.
3. **Remove the member rule.** Delete the member groups, emails and domains, and restart.

Removing the rule first exposes everything: until the instance is in personal mode, every member
sees every project, and now everyone could be a member.
