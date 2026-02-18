require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const sanitize = (input) => {
    if (typeof input !== 'string') return input;

    // Allow only specific <img> tag for stickers
    const imgRegex = /^<img\s+class="inner-sticker"\s+src="https:\/\/[^"]+"\s*\/?>$/;
    if (imgRegex.test(input.trim())) {
        return input.trim();
    }

    // Remove all < and > to prevent HTML injection
    return input.replace(/[<>]/g, '');
};

// User role utilities
function getUserClassname(userId) {
    if (userId === 1) return 'is-admin';
    if (userId === 2) return 'is-moderator';
    return 'is-user';
}

function getUserIcon(userId) {
    if (userId === 1) return "<i class='icon-admin'></i>";
    if (userId === 2) return "<i class='icon-moderator'></i>";
    return "<i class='icon-user'></i>";
}

function getUserLevelText(userId) {
    if (userId === 1) return "<span class='level-admin'>Admin</span>";
    if (userId === 2) return "<span class='level-moderator'>Moderator</span>";
    return "<span class='level-user'>User</span>";
}

// Online users and room tracking
const onlineUsers = new Map(); // socket.id -> user info
const userSockets = new Map(); // user.id -> Set of socket.ids
const roomUsers = new Map(); // roomId -> Set of socket.ids
const roomHosts = new Map(); // roomId -> userId
const roomStates = new Map(); // roomId -> { episode: { id, number }, playbackState: { action, time } }

function getOnlineUsersList() {
    const uniqueUsers = new Map();
    for (const [_, user] of onlineUsers) {
        if (!uniqueUsers.has(user.id)) {
            uniqueUsers.set(user.id, user);
        }
    }
    return Array.from(uniqueUsers.values());
}

function updateOnlineUsers() {
    io.emit('online_users', {
        users: getOnlineUsersList(),
        count: getOnlineUsersList().length
    });
}

io.on('connection', (socket) => {
    const userInfo = socket.handshake.auth || {};

    // Validate user info
    const userId = parseInt(userInfo.id) || 0;
    const username = String(userInfo.username || '').trim() || 
                    (userId ? 'user_' + userId : 'guest_' + Math.random().toString(36).substr(2, 8));

    // Create user object
    const user = {
        id: userId,
        username: username,
        avatar: (userInfo.avatar && String(userInfo.avatar).trim()) || '/public/images/no-avatar.jpeg',
        profile: userId ? `/community/user/${userId}` : '#',
        roles: parseInt(userInfo.roles) || 0,
        classname: String(userInfo.classname || '').trim() || getUserClassname(userId),
        icon: String(userInfo.icon || '').trim() || getUserIcon(userId),
        levelText: String(userInfo.levelText || '').trim() || getUserLevelText(userId),
        connectedAt: new Date().toISOString(),
        socketId: socket.id
    };

    // Add to online users
    onlineUsers.set(socket.id, user);

    // Track user's sockets
    if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
    }
    userSockets.get(userId).add(socket.id);

    // Send updated online users list
    updateOnlineUsers();

    // Handle room joining
    socket.on('join_room', async (data) => {
        const { roomId } = data;

        // Join socket.io room
        socket.join(roomId);
        console.log(`User ${socket.id} (userId: ${user.id}) joined room ${roomId}`);

        // Track user in room
        if (!roomUsers.has(roomId)) {
            roomUsers.set(roomId, new Set());
        }
        roomUsers.get(roomId).add(socket.id);

        // Update viewer count and host in database
        try {
            const [roomData] = await pool.query(
                'SELECT current_viewers, host_id, episode, episode_id FROM watch2gether_rooms WHERE room_id = ?',
                [roomId]
            );
            if (!roomData[0]) {
                socket.emit('error', { message: 'Room not found' });
                return;
            }

            await pool.query(
                'UPDATE watch2gether_rooms SET current_viewers = current_viewers + 1 WHERE room_id = ?',
                [roomId]
            );

            // Initialize room state if not present
            if (!roomStates.has(roomId)) {
                roomStates.set(roomId, {
                    episode: { id: roomData[0].episode_id, number: roomData[0].episode },
                    playbackState: { action: 'pause', time: 0 }
                });
                console.log(`Initialized roomStates for ${roomId}:`, roomStates.get(roomId));
            }

            // Set host from DB if not already set
            const dbHostIdRaw = roomData[0].host_id;
            const dbHostId = dbHostIdRaw ? Number(dbHostIdRaw) : null;

            if (dbHostId !== null) {
                const currentHostId = roomHosts.get(roomId);
                if (currentHostId !== dbHostId) {
                    roomHosts.set(roomId, dbHostId);
                }
                const isHost = dbHostId === user.id;
                socket.emit('host_status', { isHost });
                console.log(`Host for room ${roomId} set to user ${dbHostId}. Current user ${user.id} isHost=${isHost}`);
            } else if (!roomHosts.has(roomId)) {
                roomHosts.set(roomId, user.id);
                const isHost = true;
                socket.emit('host_status', { isHost });
                console.log(`Host for room ${roomId} set to user ${user.id}. Current user ${user.id} isHost=${isHost}`);
            } else {
                const currentHostId = roomHosts.get(roomId);
                socket.emit('host_status', { isHost: Number(currentHostId) === user.id });
            }

            // Broadcast updated viewer count
            io.to(roomId).emit('viewer_count_update', {
                count: roomData[0].current_viewers + 1
            });

            // Broadcast user joined message
            io.to(roomId).emit('user_joined', {
                user: {
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar
                }
            });

            // Send current room state
            socket.emit('room_state', roomStates.get(roomId));
        } catch (error) {
            console.error('Error updating viewer count:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    });

    // Handle request for room state
    socket.on('request_room_state', async ({ roomId }) => {
        console.log(`User ${socket.id} requested room state for ${roomId}`);
        try {
            const [roomData] = await pool.query(
                'SELECT episode_id, episode FROM watch2gether_rooms WHERE room_id = ?',
                [roomId]
            );
            if (!roomData[0]) {
                socket.emit('error', { message: 'Room not found' });
                return;
            }

            const roomState = roomStates.get(roomId) || {
                episode: { id: roomData[0].episode_id, number: roomData[0].episode },
                playbackState: { action: 'pause', time: 0 }
            };

            socket.emit('room_state', {
                episode: roomState.episode,
                playbackState: roomState.playbackState
                 
            });
            console.log(`Sent room state for ${roomId} to ${socket.id}:`, roomState);
        } catch (error) {
            console.error('Error fetching room state:', error);
            socket.emit('error', { message: 'Failed to fetch room state' });
        }
    });

    // Handle video control events
    socket.on('video_control', (data) => {
        const { roomId, action, time, eventId } = data;
        const hostId = roomHosts.get(roomId);
        const socketUserId = user.id;

        if (Number(socketUserId) !== Number(hostId)) {
            socket.emit('error', { message: 'Only the host can control the video' });
            return;
        }

        const safeEventId = eventId || Date.now() + Math.random().toString(36).substr(2, 8);
        roomStates.set(roomId, {
            ...roomStates.get(roomId),
            playbackState: { action, time }
        });

        io.to(roomId).emit('video_control_event', {
            action,
            time,
            userId: socketUserId,
            eventId: safeEventId
        });
        console.log(`Video control in room ${roomId}: ${action}, time: ${time}, eventId: ${safeEventId}, userId: ${socketUserId}`);

         // Update room status to 'live' when play is triggered
         if (action === 'play') {
            pool.query(
                'UPDATE watch2gether_rooms SET status = ? WHERE room_id = ?',
                ['live', roomId]
            );
            console.log(`Room ${roomId} status updated to live`);
        }
    });

    // Handle sync requests
    socket.on('request_host_sync', (data) => {
        const { roomId } = data;
        const roomState = roomStates.get(roomId);
        if (roomState && roomState.playbackState) {
            const { action, time } = roomState.playbackState;
            socket.emit('host_sync_response', {
                action,
                time,
                eventId: Date.now() + Math.random().toString(36).substr(2, 8)
            });
            console.log(`Sent host sync response for room ${roomId}: ${action}, time: ${time}`);
        } else {
            socket.emit('error', { message: 'No host playback state available' });
            console.log(`No playback state for room ${roomId}`);
        }
    });

    socket.on('stream_start', async (data) => {
        try {
            const { roomId, episodeId, episodeNumber } = data;
            const hostId = roomHosts.get(roomId);

            if (Number(user.id) !== Number(hostId)) {
                socket.emit('error', { message: 'Only the host can start the stream' });
                return;
            }

            // Persist episode and set live status
            await pool.query(
                'UPDATE watch2gether_rooms SET status = ?, episode_id = ?, episode = ? WHERE room_id = ?',
                ['live', episodeId, episodeNumber, roomId]
            );

            // Initialize/Update in-memory room state
            const prevState = roomStates.get(roomId) || { playbackState: { action: 'pause', time: 0 } };
            roomStates.set(roomId, {
                episode: { id: episodeId, number: episodeNumber },
                playbackState: prevState.playbackState
            });

            console.log(`Stream started by host in room ${roomId} for episode ${episodeId} (#${episodeNumber})`);
            io.to(roomId).emit('stream_started', {
                roomId,
                episodeId,
                episodeNumber
            });
        } catch (error) {
            console.error('Error starting stream:', error);
            socket.emit('error', { message: 'Failed to start stream' });
        }
    });

    // Handle end live (delete room)
    socket.on('end_live', async ({ roomId }) => {
        try {
            // Ensure only host can end/delete the room
            const hostId = roomHosts.get(roomId);
            const isPrivileged = user.roles >= 1;
            if (user.id !== hostId && !isPrivileged) {
                socket.emit('error', { message: 'Only the host can end the live' });
                return;
            }

            // Delete related data first if needed
            await pool.query('DELETE FROM room_messages WHERE room_id = ?', [roomId]);
            const [result] = await pool.query('DELETE FROM watch2gether_rooms WHERE room_id = ?', [roomId]);

            // Notify room users
            io.to(roomId).emit('room_ended', { roomId });

            // Cleanup in-memory state and disconnect sockets from room
            if (roomUsers.has(roomId)) {
                for (const socketId of roomUsers.get(roomId)) {
                    const s = io.sockets.sockets.get(socketId);
                    if (s) s.leave(roomId);
                }
            }
            roomUsers.delete(roomId);
            roomStates.delete(roomId);
            roomHosts.delete(roomId);

            console.log(`Room ${roomId} ended and deleted. Rows affected: ${result.affectedRows}`);
        } catch (error) {
            console.error('Error ending live:', error);
            socket.emit('error', { message: 'Failed to end live' });
        }
    });

    // Handle room leaving
    socket.on('leave_room', async (data) => {
        const { roomId } = data;

        // Leave socket.io room
        socket.leave(roomId);

        // Remove user from room tracking
        if (roomUsers.has(roomId)) {
            roomUsers.get(roomId).delete(socket.id);
            if (roomUsers.get(roomId).size === 0) {
                roomUsers.delete(roomId);
                roomStates.delete(roomId);
                roomHosts.delete(roomId);
                console.log(`Cleared room ${roomId} state`);
            }
        }

        // Update viewer count in database
        try {
            const [result] = await pool.query(
                'UPDATE watch2gether_rooms SET current_viewers = GREATEST(current_viewers - 1, 0) WHERE room_id = ?',
                [roomId]
            );

            // Get updated viewer count
            const [roomData] = await pool.query(
                'SELECT current_viewers FROM watch2gether_rooms WHERE room_id = ?',
                [roomId]
            );

            // Broadcast updated viewer count
            io.to(roomId).emit('viewer_count_update', {
                count: roomData[0].current_viewers
            });

            // Broadcast user left message
            io.to(roomId).emit('user_left', {
                user: {
                    id: user.id,
                    username: user.username
                }
            });

            // If host left, assign new host
            if (roomHosts.get(roomId) === user.id && roomUsers.get(roomId)?.size > 0) {
                const newHostSocketId = roomUsers.get(roomId).values().next().value;
                const newHost = onlineUsers.get(newHostSocketId);
                if (newHost) {
                    roomHosts.set(roomId, newHost.id);
                    io.to(roomId).emit('host_changed', { newHostId: newHost.id });
                    io.to(newHostSocketId).emit('host_status', { isHost: true });
                    console.log(`New host ${newHost.id} assigned for room ${roomId}`);
                }
            }
        } catch (error) {
            console.error('Error updating viewer count:', error);
        }
    });

    // Handle room chat messages
    socket.on('room_message', async (data) => {
        const { roomId, message, replyTo } = data;
        const time = new Date();

        let safeMessage = message;
        const imageLinkRegex = /^https:\/\/.*\.(webp|png|jpg|jpeg|gif)$/i;
        if (typeof safeMessage === 'string' && imageLinkRegex.test(safeMessage.trim())) {
            safeMessage = `<img class="inner-sticker" src="${safeMessage.trim()}" />`;
        }
        safeMessage = sanitize(safeMessage);

        let reply_id = null;
        let reply_username = null;
        let reply_text = null;
        if (replyTo && replyTo.id) {
            reply_id = parseInt(replyTo.id);
            const [rows] = await pool.query(
                'SELECT username, message FROM room_messages WHERE id = ? AND room_id = ?',
                [reply_id, roomId]
            );
            if (rows[0]) {
                reply_username = rows[0].username;
                reply_text = rows[0].message;
            }
        }

        try {
            const [result] = await pool.query(
                'INSERT INTO room_messages (room_id, user_id, username, message, time, created_at, reply_id) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
                [roomId, user.id, user.username, safeMessage, time.toISOString(), reply_id]
            );

            io.to(roomId).emit('new_room_message', {
                id: result.insertId,
                user: {
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar
                },
                message: safeMessage,
                time: time.toISOString(),
                createdAt: new Date().toISOString(),
                replyTo: reply_id ? {
                    id: reply_id,
                    username: reply_username,
                    text: reply_text
                } : null
            });
        } catch (error) {
            console.error('Error saving room message:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    // Handle host transfer
    socket.on('transfer_host', async (data) => {
        const { roomId, newHostId } = data;

        if (roomHosts.get(roomId) !== user.id) {
            socket.emit('error', { message: 'Only the current host can transfer host status' });
            return;
        }

        try {
            await pool.query(
                'UPDATE watch2gether_rooms SET host_id = ? WHERE room_id = ?',
                [newHostId, roomId]
            );

            roomHosts.set(roomId, newHostId);
            io.to(roomId).emit('host_changed', { newHostId });
            for (const socketId of roomUsers.get(roomId) || []) {
                const socketUser = onlineUsers.get(socketId);
                if (socketUser) {
                    io.to(socketId).emit('host_status', { isHost: socketUser.id === newHostId });
                }
            }
            console.log(`Host transferred to user ${newHostId} in room ${roomId}`);
        } catch (error) {
            console.error('Error transferring host:', error);
            socket.emit('error', { message: 'Failed to transfer host status' });
        }
    });

    // Handle episode change
    socket.on('change_episode', async (data) => {
        const { roomId, episode } = data;
        const hostId = roomHosts.get(roomId);

        if (user.id !== hostId) {
            socket.emit('error', { message: 'Only the host can change the episode' });
            return;
        }

        try {
            await pool.query(
                'UPDATE watch2gether_rooms SET episode_id = ?, episode = ? WHERE room_id = ?',
                [episode.id, episode.number, roomId]
            );

            roomStates.set(roomId, {
                ...roomStates.get(roomId),
                episode: { id: episode.id, number: episode.number },
                playbackState: { action: 'pause', time: 0 } // Reset playback on episode change
            });

            io.to(roomId).emit('episode_changed', { episode });
            io.to(roomId).emit('video_control_event', {
                action: 'pause',
                time: 0,
                userId: user.id,
                eventId: Date.now() + Math.random().toString(36).substr(2, 8)
            });
            console.log(`Episode changed in room ${roomId}: ID ${episode.id}, Number ${episode.number}`);
        } catch (error) {
            console.error('Error updating episode:', error);
            socket.emit('error', { message: 'Failed to change episode' });
        }
    });

    // Handle real-time message deletion
    socket.on('delete_room_message', async (data) => {
        const { roomId, messageId } = data;
        try {
            const [rows] = await pool.query(
                'SELECT user_id FROM room_messages WHERE id = ? AND room_id = ?',
                [messageId, roomId]
            );
            if (!rows[0]) {
                socket.emit('error', { message: 'Message not found' });
                return;
            }

            if (user.roles === 0 && user.id !== rows[0].user_id) {
                socket.emit('error', { message: 'Unauthorized: You cannot delete this message' });
                return;
            }

            await pool.query('DELETE FROM room_messages WHERE id = ? AND room_id = ?', [messageId, roomId]);
            io.to(roomId).emit('room_message_deleted', { id: messageId });
        } catch (error) {
            console.error('Error deleting message:', error);
            socket.emit('error', { message: 'Failed to delete message' });
        }
    });

    // Handle global messages
    socket.on('send_message', async (data) => {
        try {
            const { user_id, username, message, avatar, deco, reply_id } = data;
            const time = new Date();

            const safeUserId = parseInt(user_id) || 0;
            const safeUsername = sanitize(username) || 'paca';
            const classname = user.classname || getUserClassname(safeUserId);
            const icon = user.icon || getUserIcon(safeUserId);
            const levelText = user.levelText || getUserLevelText(safeUserId);

            let safeMessage = message;
            const imageLinkRegex = /^https:\/\/.*\.(webp|png|jpg|jpeg|gif)$/i;
            if (typeof safeMessage === 'string' && imageLinkRegex.test(safeMessage.trim())) {
                safeMessage = `<img class="inner-sticker" src="${safeMessage.trim()}" />`;
            }
            safeMessage = sanitize(safeMessage);

            const safeAvatar = sanitize(avatar) || '/public/images/no-avatar.jpeg';
            const safeDeco = sanitize(deco) || '';
            const safeReplyId = reply_id ? parseInt(reply_id) : null;

            if (!safeMessage) {
                socket.emit('error', { message: 'Message cannot be empty' });
                return;
            }

            const [rows] = await pool.query(
                'SELECT time FROM messages WHERE user_id = ? ORDER BY time DESC LIMIT 1',
                [safeUserId]
            );
            const lastTime = rows[0]?.time ? new Date(rows[0].time).getTime() : 0;
            if (Date.now() - lastTime < 5000) {
                socket.emit('error', { message: 'Slow down! Wait a few seconds.' });
                return;
            }

            const [result] = await pool.query(
                'INSERT INTO messages (user_id, username, message, time, avatar, deco, classname, icon, levelText, reply_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [safeUserId, safeUsername, safeMessage, time, safeAvatar, safeDeco, classname, icon, levelText, safeReplyId]
            );

            let reply = null;
            if (safeReplyId) {
                const [replyRows] = await pool.query(
                    'SELECT id, username, message FROM messages WHERE id = ?',
                    [safeReplyId]
                );
                if (replyRows[0]) {
                    reply = {
                        sender: { name: sanitize(replyRows[0].username) },
                        message: sanitize(replyRows[0].message)
                    };
                }
            }

            const messageData = {
                id: result.insertId,
                sender: {
                    id: safeUserId,
                    name: safeUsername,
                    classname: classname,
                    icon: icon,
                    levelText: levelText,
                    avatar: { path: safeAvatar },
                    deco: { path: safeDeco },
                    roles: user.roles
                },
                message: safeMessage,
                time: time.toISOString(),
                reply: reply
            };

            io.emit('new_message', messageData);
        } catch (error) {
            console.error('Error processing message:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    socket.on('pin_message', async (data) => {
        try {
            const { id, pinned_by } = data;
            const safeMessageId = parseInt(id);
            const safePinnedBy = parseInt(pinned_by);

            if (user.roles !== 1) {
                socket.emit('error', { message: 'Unauthorized: Only admins can pin messages' });
                return;
            }

            const [result] = await pool.query(
                'UPDATE messages SET pinned = TRUE, pinned_by = ? WHERE id = ?',
                [safePinnedBy, safeMessageId]
            );

            if (result.affectedRows === 0) {
                socket.emit('error', { message: 'Message not found' });
                return;
            }

            const [rows] = await pool.query(
                'SELECT m.id, m.user_id, m.username, m.message, m.time, m.avatar, u.username AS pinned_by_name ' +
                'FROM messages m LEFT JOIN users u ON m.pinned_by = u.id WHERE m.id = ?',
                [safeMessageId]
            );

            if (rows[0]) {
                const pinned = rows[0];
                const pinnedData = {
                    id: pinned.id,
                    sender: {
                        name: sanitize(pinned.username),
                        avatar: { path: sanitize(pinned.avatar) || '/public/images/no-avatar.jpeg' }
                    },
                    message: sanitize(pinned.message),
                    time: pinned.time,
                    pinnedBy: { name: sanitize(pinned.pinned_by_name) || 'Unknown' }
                };

                io.emit('new_pinned_message', pinnedData);
            }
        } catch (error) {
            console.error('Error pinning message:', error);
            socket.emit('error', { message: 'Failed to pin message' });
        }
    });

    socket.on('unpin_message', async (data) => {
        try {
            const { id } = data;
            const safeMessageId = parseInt(id);

            if (user.roles !== 1) {
                socket.emit('error', { message: 'Unauthorized: Only admins can unpin messages' });
                return;
            }

            const [result] = await pool.query(
                'UPDATE messages SET pinned = FALSE, pinned_by = NULL WHERE id = ?',
                [safeMessageId]
            );

            if (result.affectedRows === 0) {
                socket.emit('error', { message: 'Message not found' });
                return;
            }

            io.emit('unpin_message', { id: safeMessageId });
        } catch (error) {
            console.error('Error unpinning message:', error);
            socket.emit('error', { message: 'Failed to unpin message' });
        }
    });

    socket.on('delete_message', async (data) => {
        try {
            const { id } = data;
            const safeMessageId = parseInt(id);

            const [rows] = await pool.query(
                'SELECT user_id FROM messages WHERE id = ?',
                [safeMessageId]
            );

            if (!rows[0]) {
                socket.emit('error', { message: 'Message not found' });
                return;
            }

            if (user.roles === 0 && user.id !== rows[0].user_id) {
                socket.emit('error', { message: 'Unauthorized: You cannot delete this message' });
                return;
            }

            await pool.query('DELETE FROM messages WHERE id = ?', [safeMessageId]);
            io.emit('delete_message', { id: safeMessageId });
        } catch (error) {
            console.error('Error deleting message:', error);
            socket.emit('error', { message: 'Failed to delete message' });
        }
    });

    socket.on('disconnect', () => {
        for (const [roomId, users] of roomUsers.entries()) {
            if (users.has(socket.id)) {
                socket.emit('leave_room', { roomId });
            }
        }

        if (onlineUsers.has(socket.id)) {
            const user = onlineUsers.get(socket.id);
            if (userSockets.has(user.id)) {
                const sockets = userSockets.get(user.id);
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    userSockets.delete(user.id);
                }
            }
            onlineUsers.delete(socket.id);
            updateOnlineUsers();
        }
        console.log(`User ${socket.id} disconnected`);
    });

    socket.on('disconnect_user', () => {
        socket.disconnect();
    });

    // After socket connection
    socket.on('room_state', function(roomState) {
        if (roomState.episode) {
            loadEpisode(roomState.episode.id, roomState.episode.number);
        }
    });

});

app.delete('/messages/delete', async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM messages WHERE pinned = FALSE OR pinned IS NULL');
        res.json({ message: 'success', deleted: result.affectedRows });
        io.emit('all_messages_deleted_except_pinned');
    } catch (error) {
        console.error('Error deleting messages:', error);
        res.status(500).json({ error: 'Failed to delete messages' });
    }
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
});