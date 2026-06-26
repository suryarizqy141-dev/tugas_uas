const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2');
const db = mysql.createConnection(process.env.MYSQL_URL || {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'nama_database_lu'
});

db.connect((err) => {
    if (err) {
        console.log('Gagal koneksi ke database MySQL:', err.message);
    } else {
        console.log('Koneksi database berhasil!');
    }
});
const path = require('path');

const app = express();

// Konfigurasi Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mengunci lokasi folder views secara absolut agar EJS tidak bingung mencari path di Windows
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'dt_travel_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 } // 1 Jam
}));

// Koneksi Database MySQL Pooling
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'dt_travel',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const db = pool.promise();

// Cek Koneksi Awal ke Database saat server pertama kali di-run
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Gagal koneksi ke database MySQL:', err.message);
        console.log('PERINGATAN: Pastikan XAMPP/MySQL Anda sudah dinyalakan!');
    } else {
        console.log('Berhasil terhubung ke database MySQL (dt_travel) dengan aman.');
        connection.release();
    }
});

// =========================================================================
// 1. ROUTING HALAMAN UTAMA (Beranda Dinamis - Menampilkan Promo & Testimoni)
// =========================================================================
app.get('/', async (req, res) => {
    try {
        const [testimoni] = await db.query("SELECT * FROM testimoni LIMIT 2");
        const [promo] = await db.query("SELECT * FROM promo WHERE tanggal_berlaku >= CURDATE() LIMIT 1");

        res.render('index', { 
            dataTestimoni: testimoni, 
            dataPromo: promo[0] || null 
        });
    } catch (err) {
        console.error("Gagal memuat data Beranda:", err.message);
        res.render('index', { dataTestimoni: [], dataPromo: null });
    }
});

// =========================================================================
// 2. ROUTING HALAMAN LAYANAN
// =========================================================================
app.get('/layanan', (req, res) => {
    res.render('layanan');
});

// =========================================================================
// 3. ROUTING HALAMAN DAFTAR RUTE POPULER
// =========================================================================
app.get('/rute', async (req, res) => {
    try {
        const [rute] = await db.query("SELECT * FROM rute_populer WHERE status_aktif = 1");
        res.render('rute', { dataRute: rute });
    } catch (err) {
        console.error("Gagal memuat data rute:", err.message);
        res.status(500).send("Gagal memuat data rute perjalanan.");
    }
});

// =========================================================================
// 4. ROUTING HALAMAN GALERI ARMADA
// =========================================================================
app.get('/armada', async (req, res) => {
    try {
        const [armada] = await db.query("SELECT * FROM armada");
        res.render('armada', { dataArmada: armada });
    } catch (err) {
        console.error("Gagal memuat data armada:", err.message);
        res.status(500).send("Gagal memuat data armada.");
    }
});

// =========================================================================
// 5. ROUTING HALAMAN KHUSUS FORM PEMESANAN TIKET
// =========================================================================
app.get('/pemesanan', async (req, res) => {
    try {
        const [rute] = await db.query("SELECT * FROM rute_populer WHERE status_aktif = 1");
        const [armada] = await db.query("SELECT * FROM armada");
        
        res.render('pemesanan', { 
            dataRute: rute, 
            dataArmada: armada, 
            message: null 
        });
    } catch (err) {
        console.error("Gagal membuka form pemesanan:", err.message);
        res.status(500).send("Gagal memuat formulir transaksi.");
    }
});

// HANDLER PROSES SUBMIT FORMULIR PEMESANAN (POST)
app.post('/pesan', async (req, res) => {
    const { nama, whatsapp, rute, armada, tanggal, penumpang, catatan } = req.body;

    try {
        const queryInsert = `
            INSERT INTO bookings 
            (nama_lengkap, no_whatsapp, rute, armada, tanggal_keberangkatan, jumlah_penumpang, catatan) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        await db.query(queryInsert, [nama, whatsapp, rute, armada, tanggal, penumpang, catatan]);

        // Ambil kembali data rute dan armada untuk me-render ulang halaman pemesanan
        const [ruteDb] = await db.query("SELECT * FROM rute_populer WHERE status_aktif = 1");
        const [armadaDb] = await db.query("SELECT * FROM armada");

        res.render('pemesanan', { 
            message: { 
                type: 'success', 
                text: `Terima kasih ${nama}, reservasi Anda berhasil disimpan! Admin kami akan segera menghubungi Anda di WhatsApp ${whatsapp}.` 
            },
            dataRute: ruteDb,
            dataArmada: armadaDb
        });

    } catch (err) {
        console.error("Gagal menyimpan booking:", err.message);
        res.status(500).send("Terjadi kesalahan sistem saat memproses pesanan.");
    }
});

// =========================================================================
// 6. ROUTING LOGIN ADMIN & DASHBOARD
// =========================================================================

// Middleware Keamanan Admin
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/login');
}

app.get('/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin/dashboard');
    }
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const [rows] = await db.query("SELECT * FROM admins WHERE username = ? LIMIT 1", [username]);
        
        if (rows.length === 0) {
            return res.render('login', { error: 'Username tidak terdaftar!' });
        }

        const admin = rows[0];
        
        // Hashing fallback logic
        let match = false;
        try {
            match = await bcrypt.compare(password, admin.password);
        } catch (e) {
            match = false;
        }

        // Jika hashing comparison gagal, coba bandingkan plain-text untuk migrasi awal
        if (!match && !admin.password.startsWith('$2b$')) {
            if (password === admin.password) {
                match = true;
                // Auto-hash plain text password dan update di database demi keamanan
                const hashedPassword = await bcrypt.hash(password, 10);
                await db.query("UPDATE admins SET password = ? WHERE id = ?", [hashedPassword, admin.id]);
                console.log(`[SECURITY] Password admin "${username}" otomatis dimigrasi ke hash bcrypt.`);
            }
        }
        
        if (match) {
            req.session.isAdmin = true;
            req.session.adminNama = admin.nama_lengkap;
            res.redirect('/admin/dashboard');
        } else {
            res.render('login', { error: 'Password yang Anda masukkan salah!' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).send("Kesalahan sistem login.");
    }
});

// ROUTE DASHBOARD ADMIN
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
    try {
        const [bookings] = await db.query("SELECT * FROM bookings ORDER BY created_at DESC");
        const [ruteCount] = await db.query("SELECT COUNT(*) as count FROM rute_populer WHERE status_aktif = 1");
        const [armadaCount] = await db.query("SELECT COUNT(*) as count FROM armada");
        
        // Menghitung jumlah total penumpang
        let totalPassengers = 0;
        bookings.forEach(b => {
            totalPassengers += Number(b.jumlah_penumpang || 0);
        });

        res.render('admin/dashboard', {
            adminNama: req.session.adminNama,
            bookings: bookings,
            stats: {
                totalBookings: bookings.length,
                totalPassengers: totalPassengers,
                activeRoutes: ruteCount[0].count,
                totalArmada: armadaCount[0].count
            }
        });
    } catch (err) {
        console.error("Gagal memuat dashboard:", err.message);
        res.status(500).send("Gagal memuat dashboard admin.");
    }
});

// ROUTE DELETE BOOKING
app.post('/admin/bookings/delete/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await db.query("DELETE FROM bookings WHERE id = ?", [id]);
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error("Gagal menghapus booking:", err.message);
        res.status(500).send("Gagal menghapus reservasi.");
    }
});

// ROUTE LOGOUT
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Gagal melakukan destroy session:", err);
        }
        res.redirect('/login');
    });
});

// =========================================================================
// RUN SERVER DENGAN DETEKSI PORT OTOMATIS (ANTI-BENZROK)
// =========================================================================
const START_PORT = 3100;

function startServer(port) {
    const server = app.listen(port, () => {
        console.log(`==================================================================`);
        console.log(`SISTEM MEWAH MULTI-HALAMAN SUDAH AKTIF`);
        console.log(`Silakan akses di browser Anda: http://localhost:${port}`);
        console.log(`==================================================================`);
    });

    // Jika port yang dituju ternyata sibuk, otomatis naik ke port berikutnya
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️ Port ${port} sedang digunakan. Mencoba port berikutnya: ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error('Terjadi error pada server:', err.message);
        }
    });
}

// Menjalankan inisialisasi server pertama kali
startServer(START_PORT);