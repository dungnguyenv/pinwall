# Backup and restore

`pinwall backup` writes one archive: a consistent snapshot of the database and every file that a
version uses, whatever the storage setup. Write it to standard output and keep it on the machine
you run the command from:

```sh
docker exec pinwall pinwall backup --out - > pinwall-$(date +%F).tar
```

Never add `-t` to `docker exec` here. A terminal rewrites line endings in the stream and ruins the
archive, so `pinwall backup --out -` refuses to write to one. A backup first writes the tables to temporary files under `/data/tmp`, so keep some room
in the data volume. On Kubernetes:

```sh
kubectl exec deploy/pinwall -- pinwall backup --out - > pinwall-$(date +%F).tar
```

Run the backup in the server's container, as these commands do, or with the server's own image. A
backup never migrates the database, so a newer or older Pinwall refuses to back it up.

`pinwall restore` rebuilds an installation from an archive, into any storage setup, as long as the
target is empty (a new volume, or an empty database and bucket prefix). It refuses a target that is
not empty before it changes anything there, so a restore pointed at a database in use by mistake
does not even migrate it. It checks the whole archive before it writes anything:

```sh
docker exec -i <new container> pinwall restore --in - < pinwall.tar
kubectl exec -i deploy/pinwall -- pinwall restore --in - < pinwall.tar
```

Let nobody sign in to the new installation until the restore logs `restore complete`. If someone
signs in or publishes there meanwhile, the restore stops without restoring anything, and the target
is no longer empty.

What to know about the archive:

- It holds the whole database: accounts, password hashes, passkeys, sessions, API and OAuth tokens
  (as hashes), projects, artifacts, versions, comments, share links, and every stored file. It is
  as sensitive as the database, so store and move it that way.
- Deleting an artifact, a version or a comment removes it from the running installation and from its
  storage. It stays in every backup made before, and a restore of such a backup brings it back. When
  something secret was published, delete the older backups too.
- It does not hold the secret key. Pinwall derives its encryption and signing keys from
  `PINWALL_SECRET_KEY`, or from the `secret.key` file that it generates in the data folder, and
  uses them for the identity provider's refresh tokens and for the unlock of password-protected
  share links. Back the key up separately, next to the archive but not inside it. Restore with a
  different key and the single sign-on users have to sign in again, which the restore warns about.

## Moving from SQLite and local disk to Postgres and S3

A backup restores into any storage setup, which makes it the way from the default install to a
larger one. The Compose file
[deploy/compose/docker-compose.postgres-s3.yml](../deploy/compose/docker-compose.postgres-s3.yml)
shows the target: PostgreSQL, an S3-compatible service and Pinwall. Its S3 service is `pgsty/silo`,
a maintained fork of MinIO, because MinIO's community images can no longer be pulled. Any
S3-compatible store works in its place.

1. **Back up** the old install: `docker exec pinwall pinwall backup --out - > pinwall.tar`. After
   this, publish nothing more to the old install, because the new one will not have it.
2. **Read the old secret key** as hex into a file:

   ```sh
   docker exec pinwall od -An -tx1 -v /data/secret.key | tr -d ' \n' > secret_key
   ```

3. **Start the Postgres and S3 stack** with that key. In the Compose file's secrets folder, put the
   contents of `secret_key` in the file `secret-key` instead of generating a new key. That file
   is what `PINWALL_SECRET_KEY_FILE` points at. On Kubernetes, put it in the `secret-key` entry of
   your Secret. Use the address of the old install as `PINWALL_PUBLIC_ORIGIN`, since that is the
   one people will reach it at.
4. **Restore** into the new, empty install:
   `docker exec -i <new container> pinwall restore --in - < pinwall.tar`. A Compose container is
   named `pinwall-pinwall-1`. The restore logs what it moved, and prints a warning if it could not
   keep single sign-on users signed in.
5. **Check** `/readyz` on the new install (the Compose file publishes the port on `127.0.0.1`, and
   `PINWALL_PORT_PUBLISHED` moves it while the old install still holds 8080), then **switch DNS**
   or your proxy to it. Open an artifact and a share link. Keep the old volume for a while in case
   you need to go back.

Without the old key, the restore still works, and everyone who signs in through single sign-on has
to sign in again. The owner account and its passkeys are not affected.
