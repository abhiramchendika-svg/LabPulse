# Deploying LabPulse

Two ways to put LabPulse online:

- **[Free: Render + Neon](#free-render--neon)**: no card, no server to manage, an `https://….onrender.com` address. It sleeps when nobody uses it and takes about a minute to wake up.
- **[Your own server](#your-own-server)**: always on, your own domain, a few dollars a month.

---

## Free: Render + Neon

Render runs the app and Neon holds the database. Both have free plans, and you sign in to both with your GitHub account.

### 1. Put the code on GitHub

1. Install Git if you don't have it (PowerShell): `winget install --id Git.Git`, then close and reopen PowerShell.
2. On github.com, click **New repository**, name it `labpulse`, choose **Private**, and **don't** add a README. Click **Create repository**.
3. In PowerShell (replace `<you>` with your GitHub username):

   ```powershell
   cd C:\Abhiram_Projects\LabPulse
   git init
   git add .
   git commit -m "LabPulse"
   git branch -M main
   git remote add origin https://github.com/<you>/labpulse.git
   git push -u origin main
   ```

   Your `.env` file is **not** uploaded (it's listed in `.gitignore`), so your local invite code stays private.

### 2. Create the database on Neon

1. Go to **neon.tech** and sign up with GitHub.
2. Create a project: name `labpulse`, region **AWS Asia Pacific (Singapore)** (closest to India).
3. Click **Connect**. Turn **Connection pooling OFF**: LabPulse needs a direct connection.
4. Copy the connection string. It looks like:
   `postgresql://neondb_owner:abc123@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
5. Delete `&channel_binding=require` from the end. Keep the rest, including `?sslmode=require`. This is your **DATABASE_URL**.

### 3. Create the app on Render

1. Go to **render.com** and sign up with GitHub.
2. Click **New → Web Service**, connect GitHub if asked, and pick the `labpulse` repository.
3. Fill in:
   - **Language:** Docker (Render detects the `Dockerfile`)
   - **Branch:** main
   - **Region:** Singapore
   - **Instance type:** Free
4. Under **Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 2 |
   | `INSTRUCTOR_SIGNUP_CODE` | a secret code for instructors |
   | `COOKIE_SECURE` | `true` |
   | `PYODIDE_URL` | `https://cdn.jsdelivr.net/pyodide/v0.29.5/full/` |

   Don't add `REDIS_URL`: one free instance doesn't need Redis.
5. Under **Advanced**, set **Health Check Path** to `/api/health`.
6. Click **Create Web Service**. The first build takes 5 to 10 minutes; the log ends with `Server listening on port 10000`.

### 4. Use it

1. Render shows your address at the top, e.g. `https://labpulse-ab12.onrender.com`.
2. Open `https://labpulse-ab12.onrender.com/teach`, choose **Create an account**, and enter the invite code.
3. Students go to `https://labpulse-ab12.onrender.com` and type the room code.

**Before each class, open the address 2 minutes early.** A free Render app sleeps after 15 minutes without visitors and takes about a minute to wake. Once your dashboard is open, it stays awake for the whole lab.

**Updating:** run `git add . && git commit -m "update" && git push` and Render rebuilds automatically. Exercises are part of the code, so changing an exercise also means commit, push and wait for the rebuild.

### What the free plans allow

- **Render Free:** 750 hours a month (enough for one app running all month), 5 GB of downloads a month for the whole workspace. With `PYODIDE_URL` set, students download Python from the jsDelivr CDN, so each student costs Render only about 1 MB, or roughly 60 MB for a class of 60. If the 5 GB ever runs out, Render pauses free apps until the next month. Render may also restart a free app at any time; students' pages reconnect on their own.
- **Neon Free:** 1 GB of storage per project (years of lab reports) and 100 compute-hours a month. The database pauses after 5 idle minutes and wakes in about a second.
- If a student's network blocks the CDN, their browser quietly falls back to downloading Python from your Render app instead.

---

## Your own server

This puts LabPulse on the internet at `https://your-domain`, with a free HTTPS certificate that renews itself. Students can join from any network.

You need:

- A **Linux server** (Ubuntu 24.04) with **2 GB RAM**, 1 vCPU and 25 GB disk. That's enough for a few hundred students at once, because Python runs in the students' browsers, not on the server. A region close to your students keeps it fast: DigitalOcean Bangalore or AWS Lightsail Mumbai work well. If you have the GitHub Student Developer Pack, check its current cloud credits.
- A **domain name** pointing at the server. No domain? Skip buying one: `203-0-113-5.sslip.io` (your server's IP with dashes) works as a free domain name and gets a real certificate.

Everything below runs on the server, over SSH.

---

## 1. Create the server and point the domain at it

1. Create the server (Ubuntu 24.04, 2 GB RAM). Add your SSH key when asked.
2. Note its public IP address, for example `203.0.113.5`.
3. At your domain registrar, add an **A record** for the name you want (e.g. `labpulse.yourcollege.in`) pointing at that IP. If you use sslip.io, there's nothing to set up.
4. Make sure ports **22, 80 and 443** are open in the provider's firewall (Lightsail: *Networking* tab; DigitalOcean: *Networking → Firewalls*).

## 2. Install Docker

```bash
ssh root@203.0.113.5
curl -fsSL https://get.docker.com | sh
docker compose version     # should print a version
```

On a server with only 1 GB RAM, add swap first, or the build runs out of memory:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 3. Copy LabPulse to the server

**With GitHub (recommended, makes updates easy):** push the project to a private repository, then on the server:

```bash
git clone https://github.com/<you>/labpulse.git
cd labpulse
```

**Without GitHub:** from your Windows laptop (PowerShell), in the folder that contains `LabPulse.zip`:

```powershell
scp LabPulse.zip root@203.0.113.5:~
```

Then on the server:

```bash
apt-get install -y unzip && unzip LabPulse.zip -d labpulse && cd labpulse
```

## 4. Configure it

```bash
cp .env.production.example .env
openssl rand -hex 24      # copy this for POSTGRES_PASSWORD
nano .env
```

Fill in all three values:

```
DOMAIN=labpulse.yourcollege.in
POSTGRES_PASSWORD=<the random string from openssl>
INSTRUCTOR_SIGNUP_CODE=<a code you'll give instructors>
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`.

The invite code stops strangers from creating instructor accounts on your public server. Students never need it: they join with the room code.

## 5. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes about 5 minutes. Then check:

```bash
docker compose -f docker-compose.prod.yml ps        # every service "running" / "healthy"
docker compose -f docker-compose.prod.yml logs app  # "Server listening on port 8080"
```

Open `https://<your DOMAIN>/teach`, choose **Create an account**, and enter the invite code. Open a lab, and students go to `https://<your DOMAIN>` and type the room code.

LabPulse starts again by itself if the server reboots.

---

## Everyday tasks

To save typing, run this once per SSH session:

```bash
alias lp="docker compose -f docker-compose.prod.yml"
```

| Task | Command |
|---|---|
| See logs | `lp logs -f app` |
| Restart | `lp restart app` |
| Stop everything | `lp down` (data is kept) |
| Update to new code | `git pull && lp up -d --build` (or upload a new zip and unzip over the folder) |
| Change exercises | Edit files in `exercises/` on the server; the next lab you open uses them. No restart needed. |

### Back up the database

Labs, students and reports live in Postgres. Make a backup:

```bash
mkdir -p ~/backups
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U labpulse labpulse | gzip > ~/backups/labpulse-$(date +%F).sql.gz
```

Back up automatically every night at 2 AM (keeps 14 days):

```bash
(crontab -l 2>/dev/null; echo "0 2 * * * cd $PWD && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U labpulse labpulse | gzip > ~/backups/labpulse-\$(date +\%F).sql.gz && find ~/backups -name 'labpulse-*.sql.gz' -mtime +14 -delete") | crontab -
```

Restore a backup (this replaces everything currently in the database):

```bash
lp stop app
lp exec -T postgres psql -U labpulse -d postgres -c "DROP DATABASE labpulse;" -c "CREATE DATABASE labpulse OWNER labpulse;"
gunzip -c ~/backups/labpulse-2026-10-18.sql.gz | lp exec -T postgres psql -U labpulse labpulse
lp start app
```

Copy backups off the server now and then (e.g. `scp root@203.0.113.5:~/backups/* .` from your laptop).

---

## If something goes wrong

- **The browser says the site can't be reached, or there's a certificate error.** Caddy couldn't get a certificate. Check that the domain points at this server (`ping <your DOMAIN>` shows the server's IP) and that ports 80 and 443 are open. Then `lp logs caddy` explains the exact problem. It retries on its own once you fix DNS or the firewall.
- **`Set POSTGRES_PASSWORD in .env` (or DOMAIN / INSTRUCTOR_SIGNUP_CODE).** The `.env` file is missing a value, or it isn't in the same folder as `docker-compose.prod.yml`.
- **The build stops with "killed" or exit code 137.** The server ran out of memory. Add swap (step 2) and run the start command again.
- **You changed `POSTGRES_PASSWORD` after the first start.** Postgres keeps the password it was created with. Put the old one back, or, only if you have no data to keep, run `lp down -v` to wipe the database and start fresh.
- **Students see "Reconnecting…".** Their network may block WebSockets. Most college networks allow them over HTTPS (port 443), which this setup uses.
