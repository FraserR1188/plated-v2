// ============================================================
// src/screens/FriendsScreen.tsx
// ============================================================
// Friends tab: shows the people you follow (with their today
// calorie summary) and a search bar to find new users.
// ============================================================

import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Animated,
  Pressable,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import {
  Colors,
  Spacing,
  Typography,
  Radius,
  Fonts,
  withDefaultFont,
} from "../theme/tokens";
import {
  searchUsers,
  requestFriend,
  acceptFriend,
  declineFriend,
  unfriend,
  getFriends,
  getIncomingRequests,
  getTodayCaloriesForUser,
} from "../lib/social";
import {
  RootStackParamList,
  ProfileWithFriendState,
  FriendshipState,
  Profile,
} from "../types";
import { dateKey } from "../lib/time";
import { reportError } from "../lib/reportError";
import { useStore } from "../store/useStore";

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ─── Avatar placeholder ──────────────────────────────────────

function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initial = (name?.[0] ?? "?").toUpperCase();
  // Deterministic colour from first char
  const hue = ((name?.charCodeAt(0) ?? 65) * 17) % 360;
  const bg = `hsl(${hue}, 50%, 28%)`;
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
        },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>
        {initial}
      </Text>
    </View>
  );
}

// ─── Macro dot ──────────────────────────────────────────────

function CaloriePill({ calories }: { calories: number }) {
  return (
    <View style={styles.caloriePill}>
      <Text style={styles.caloriePillText}>{Math.round(calories)}</Text>
      <Text style={styles.caloriePillLabel}> kcal today</Text>
    </View>
  );
}

// ─── Friend action button ───────────────────────────────────
//
// One row, four possible relationships (ProfileWithFriendState.friendship),
// four different controls. "incoming_pending" renders two buttons — the rest
// render one.

function FriendActionButton({
  friendship,
  onRequest,
  onCancel,
  onAccept,
  onDecline,
  onUnfriend,
  loading,
}: {
  friendship: FriendshipState;
  onRequest: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onUnfriend: () => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <View style={[styles.followBtn, styles.followBtnActive]}>
        <ActivityIndicator size="small" color={Colors.textSub} />
      </View>
    );
  }

  if (friendship === "incoming_pending") {
    return (
      <View style={styles.requestActions}>
        <TouchableOpacity
          onPress={onAccept}
          activeOpacity={0.7}
          style={[
            styles.followBtn,
            styles.followBtnInactive,
            styles.requestActionBtn,
          ]}
        >
          <Text style={[styles.followBtnText, { color: Colors.bg }]}>
            Accept
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onDecline}
          activeOpacity={0.7}
          style={[
            styles.followBtn,
            styles.followBtnActive,
            styles.requestActionBtn,
          ]}
        >
          <Text style={[styles.followBtnText, { color: Colors.textSub }]}>
            Decline
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (friendship === "accepted") {
    return (
      <TouchableOpacity
        onPress={onUnfriend}
        activeOpacity={0.7}
        style={[styles.followBtn, styles.followBtnActive]}
      >
        <Text style={[styles.followBtnText, { color: Colors.textSub }]}>
          Friends
        </Text>
      </TouchableOpacity>
    );
  }

  if (friendship === "outgoing_pending") {
    return (
      <TouchableOpacity
        onPress={onCancel}
        activeOpacity={0.7}
        style={[styles.followBtn, styles.followBtnActive]}
      >
        <Text style={[styles.followBtnText, { color: Colors.textSub }]}>
          Requested
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={onRequest}
      activeOpacity={0.7}
      style={[styles.followBtn, styles.followBtnInactive]}
    >
      <Text style={[styles.followBtnText, { color: Colors.bg }]}>
        Add Friend
      </Text>
    </TouchableOpacity>
  );
}

// ─── User row (search results) ───────────────────────────────

interface UserRowProps {
  item: ProfileWithFriendState;
  onRequest: (userId: string) => void;
  onCancel: (userId: string) => void;
  onAccept: (userId: string) => void;
  onDecline: (userId: string) => void;
  onUnfriend: (userId: string) => void;
  onPress: (profile: Profile) => void;
  loadingId: string | null;
}

function UserRow({
  item,
  onRequest,
  onCancel,
  onAccept,
  onDecline,
  onUnfriend,
  onPress,
  loadingId,
}: UserRowProps) {
  const displayName = item.display_name ?? item.username;
  const isLoading = loadingId === item.user_id;

  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [
        styles.userRow,
        pressed && styles.userRowPressed,
      ]}
    >
      <Avatar name={displayName} />
      <View style={styles.userRowMeta}>
        <Text style={styles.userRowDisplayName} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.userRowUsername}>@{item.username}</Text>
      </View>
      <FriendActionButton
        friendship={item.friendship}
        onRequest={() => onRequest(item.user_id)}
        onCancel={() => onCancel(item.user_id)}
        onAccept={() => onAccept(item.user_id)}
        onDecline={() => onDecline(item.user_id)}
        onUnfriend={() => onUnfriend(item.user_id)}
        loading={isLoading}
      />
    </Pressable>
  );
}

// ─── Friend row (following list) ─────────────────────────────

interface FriendRowProps {
  item: ProfileWithFriendState & { todayCalories?: number };
  onUnfriend: (userId: string) => void;
  onPress: (profile: Profile) => void;
  loadingId: string | null;
}

function FriendRow({ item, onUnfriend, onPress, loadingId }: FriendRowProps) {
  const displayName = item.display_name ?? item.username;
  const isLoading = loadingId === item.user_id;

  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [
        styles.friendRow,
        pressed && styles.userRowPressed,
      ]}
    >
      <Avatar name={displayName} size={48} />
      <View style={styles.friendRowMeta}>
        <Text style={styles.userRowDisplayName} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.userRowUsername}>@{item.username}</Text>
        {typeof item.todayCalories === "number" && item.todayCalories > 0 && (
          <CaloriePill calories={item.todayCalories} />
        )}
      </View>
      <TouchableOpacity
        onPress={() => onUnfriend(item.user_id)}
        disabled={isLoading}
        activeOpacity={0.7}
        style={styles.unfollowBtn}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={Colors.textMuted} />
        ) : (
          <Text style={styles.unfollowBtnText}>Remove</Text>
        )}
      </TouchableOpacity>
    </Pressable>
  );
}

// ─── Incoming request row ────────────────────────────────────
//
// Visually distinct from UserRow/FriendRow: tinted card with an accent
// border, not a plain list row, so a pending request reads as something
// that needs a decision rather than just another search result.

interface RequestRowProps {
  item: ProfileWithFriendState;
  onAccept: (userId: string) => void;
  onDecline: (userId: string) => void;
  loadingId: string | null;
}

function RequestRow({ item, onAccept, onDecline, loadingId }: RequestRowProps) {
  const displayName = item.display_name ?? item.username;
  const isLoading = loadingId === item.user_id;

  return (
    <View style={styles.requestRow}>
      <Avatar name={displayName} size={40} />
      <View style={styles.requestRowMeta}>
        <Text style={styles.userRowDisplayName} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.userRowUsername}>@{item.username}</Text>
      </View>
      {isLoading ? (
        <ActivityIndicator size="small" color={Colors.textSub} />
      ) : (
        <View style={styles.requestActions}>
          <TouchableOpacity
            onPress={() => onAccept(item.user_id)}
            activeOpacity={0.7}
            style={[
              styles.followBtn,
              styles.followBtnInactive,
              styles.requestActionBtn,
            ]}
          >
            <Text style={[styles.followBtnText, { color: Colors.bg }]}>
              Accept
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onDecline(item.user_id)}
            activeOpacity={0.7}
            style={[
              styles.followBtn,
              styles.followBtnActive,
              styles.requestActionBtn,
            ]}
          >
            <Text style={[styles.followBtnText, { color: Colors.textSub }]}>
              Decline
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Empty state ─────────────────────────────────────────────

function EmptyFriends() {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>👥</Text>
      <Text style={styles.emptyTitle}>No one here yet</Text>
      <Text style={styles.emptyBody}>
        Search for friends by username and send a request to see their daily
        log.
      </Text>
    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────

export function FriendsScreen() {
  const navigation = useNavigation<Nav>();
  const fetchIncomingRequestCount = useStore(
    (s) => s.fetchIncomingRequestCount,
  );

  // Search state
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProfileWithFriendState[]>(
    [],
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Friends list + incoming requests state
  const [friends, setFriends] = useState<
    (ProfileWithFriendState & { todayCalories?: number })[]
  >([]);
  const [incomingRequests, setIncomingRequests] = useState<
    ProfileWithFriendState[]
  >([]);
  const [loadingList, setLoadingList] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Per-row loading state (request / accept / decline / unfriend in-flight)
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Debounce ref
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load friends + incoming requests ───────────────────────

  const loadFriends = useCallback(async () => {
    try {
      const [friendList, requests] = await Promise.all([
        getFriends(),
        getIncomingRequests(),
      ]);
      // Fetch today's calories for each friend in parallel
      const enriched = await Promise.all(
        friendList.map(async (f) => ({
          ...f,
          todayCalories: await getTodayCaloriesForUser(f.user_id),
        })),
      );
      setFriends(enriched);
      setIncomingRequests(requests);
    } catch (err) {
      reportError("loadFriends", err);
    } finally {
      setLoadingList(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFriends();
  }, [loadFriends]);

  // ── Search ─────────────────────────────────────────────────

  const handleSearchChange = useCallback((text: string) => {
    setQuery(text);
    setSearchError(null);

    if (searchTimer.current) clearTimeout(searchTimer.current);

    if (text.trim().length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchUsers(text.trim());
        setSearchResults(results);
      } catch (err) {
        reportError("searchUsers", err);
        setSearchError("Search failed. Try again.");
      } finally {
        setSearching(false);
      }
    }, 350); // debounce
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
    setSearchResults([]);
    setSearchError(null);
  }, []);

  // ── Friend requests ────────────────────────────────────────

  const handleRequestFriend = useCallback(async (userId: string) => {
    setLoadingId(userId);
    try {
      const { error } = await requestFriend(userId);
      if (error) {
        Alert.alert("Error", error);
        return;
      }
      setSearchResults((prev) =>
        prev.map((u) =>
          u.user_id === userId ? { ...u, friendship: "outgoing_pending" } : u,
        ),
      );
    } catch (err) {
      reportError("handleRequestFriend", err);
      Alert.alert(
        "Error",
        "Could not send that friend request. Please try again.",
      );
    } finally {
      setLoadingId(null);
    }
  }, []);

  const handleAcceptRequest = useCallback(
    async (userId: string) => {
      setLoadingId(userId);
      try {
        const { error } = await acceptFriend(userId);
        if (error) {
          Alert.alert("Error", error);
          return;
        }
        setSearchResults((prev) =>
          prev.map((u) =>
            u.user_id === userId ? { ...u, friendship: "accepted" } : u,
          ),
        );
        setIncomingRequests((prev) =>
          prev.filter((r) => r.user_id !== userId),
        );
        await loadFriends();
        // Clears the tab badge immediately, without waiting for foreground.
        await fetchIncomingRequestCount();
      } catch (err) {
        reportError("handleAcceptRequest", err);
        Alert.alert(
          "Error",
          "Could not accept that request. Please try again.",
        );
      } finally {
        setLoadingId(null);
      }
    },
    [loadFriends, fetchIncomingRequestCount],
  );

  // Covers both "decline an incoming request" and "cancel one I sent" — same
  // underlying declineFriend() delete either way (see social.ts). Either way,
  // refreshing the badge count is a correct no-op at worst: cancelling my own
  // outgoing request doesn't change MY incoming count, but re-fetching it still
  // returns the right number.
  const handleDismissRequest = useCallback(
    async (userId: string) => {
      setLoadingId(userId);
      try {
        const { error } = await declineFriend(userId);
        if (error) {
          Alert.alert("Error", error);
          return;
        }
        setSearchResults((prev) =>
          prev.map((u) =>
            u.user_id === userId ? { ...u, friendship: "none" } : u,
          ),
        );
        setIncomingRequests((prev) =>
          prev.filter((r) => r.user_id !== userId),
        );
        await fetchIncomingRequestCount();
      } catch (err) {
        reportError("handleDismissRequest", err);
        Alert.alert(
          "Error",
          "Could not update that request. Please try again.",
        );
      } finally {
        setLoadingId(null);
      }
    },
    [fetchIncomingRequestCount],
  );

  const handleUnfriend = useCallback((userId: string) => {
    Alert.alert(
      "Remove friend",
      "You'll no longer be able to see each other's log.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setLoadingId(userId);
            try {
              const { error } = await unfriend(userId);
              if (error) {
                Alert.alert("Error", error);
                return;
              }
              setFriends((prev) => prev.filter((f) => f.user_id !== userId));
              setSearchResults((prev) =>
                prev.map((u) =>
                  u.user_id === userId ? { ...u, friendship: "none" } : u,
                ),
              );
            } catch (err) {
              reportError("handleUnfriend", err);
              Alert.alert(
                "Error",
                "Could not remove this friend. Please try again.",
              );
            } finally {
              setLoadingId(null);
            }
          },
        },
      ],
    );
  }, []);

  // ── Navigate to connected user's log ──────────────────────

  const handleViewLog = useCallback(
    (profile: Profile) => {
      navigation.navigate("ConnectedUserLog", {
        profile,
        date: dateKey(),
      });
    },
    [navigation],
  );

  // ── Render ─────────────────────────────────────────────────

  const isSearching = query.trim().length >= 2;

  return (
    <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.title}>Friends</Text>
      </View>

      {/* ── Search bar ── */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search by username"
            placeholderTextColor={Colors.textMuted}
            value={query}
            onChangeText={handleSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={clearSearch} hitSlop={8}>
              <Text style={styles.clearBtn}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Search results ── */}
      {isSearching ? (
        <View style={styles.flex}>
          {searching ? (
            <View style={styles.centred}>
              <ActivityIndicator color={Colors.green} />
            </View>
          ) : searchError ? (
            <View style={styles.centred}>
              <Text style={styles.errorText}>{searchError}</Text>
            </View>
          ) : searchResults.length === 0 ? (
            <View style={styles.centred}>
              <Text style={styles.emptySearchText}>
                No users found for "{query}"
              </Text>
            </View>
          ) : (
            <FlatList
              data={searchResults}
              keyExtractor={(item) => item.user_id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => (
                <UserRow
                  item={item}
                  onRequest={handleRequestFriend}
                  onCancel={handleDismissRequest}
                  onAccept={handleAcceptRequest}
                  onDecline={handleDismissRequest}
                  onUnfriend={handleUnfriend}
                  onPress={handleViewLog}
                  loadingId={loadingId}
                />
              )}
              ItemSeparatorComponent={() => <View style={styles.divider} />}
              keyboardShouldPersistTaps="handled"
            />
          )}
        </View>
      ) : (
        /* ── Friends list ── */
        <View style={styles.flex}>
          {loadingList ? (
            <View style={styles.centred}>
              <ActivityIndicator color={Colors.green} />
            </View>
          ) : (
            <>
              {incomingRequests.length > 0 && (
                <View style={styles.requestsSection}>
                  <Text style={styles.sectionLabel}>Requests</Text>
                  {incomingRequests.map((r) => (
                    <RequestRow
                      key={r.user_id}
                      item={r}
                      onAccept={handleAcceptRequest}
                      onDecline={handleDismissRequest}
                      loadingId={loadingId}
                    />
                  ))}
                </View>
              )}
              {friends.length > 0 && (
                <Text style={styles.sectionLabel}>Friends</Text>
              )}
              <FlatList
                data={friends}
                keyExtractor={(item) => item.user_id}
                contentContainerStyle={[
                  styles.listContent,
                  friends.length === 0 && styles.listContentEmpty,
                ]}
                ListEmptyComponent={<EmptyFriends />}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={Colors.green}
                  />
                }
                renderItem={({ item }) => (
                  <FriendRow
                    item={item}
                    onUnfriend={handleUnfriend}
                    onPress={handleViewLog}
                    loadingId={loadingId}
                  />
                )}
                ItemSeparatorComponent={() => <View style={styles.divider} />}
              />
            </>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create(
  withDefaultFont({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  flex: { flex: 1 },

  // Header
  header: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  title: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    color: Colors.text,
  },

  // Search
  searchRow: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface2,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.sm,
    height: 44,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: Spacing.xs,
  },
  searchInput: {
    flex: 1,
    fontSize: Typography.base,
    color: Colors.text,
    paddingVertical: 0,
  },
  clearBtn: {
    fontSize: 14,
    color: Colors.textMuted,
    padding: 4,
  },

  // Section label
  sectionLabel: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textMuted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
  },

  // List
  listContent: { paddingBottom: Spacing.xxl },
  listContentEmpty: { flex: 1 },
  divider: {
    height: 1,
    backgroundColor: Colors.borderSub,
    marginHorizontal: Spacing.md,
  },

  // User row (search results)
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.bg,
  },
  userRowPressed: {
    backgroundColor: Colors.surface,
  },
  userRowMeta: {
    flex: 1,
    marginLeft: Spacing.sm,
    marginRight: Spacing.xs,
  },
  userRowDisplayName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.text,
    flexShrink: 1,
  },
  userRowUsername: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },

  // Incoming requests — tinted card + accent border, deliberately distinct
  // from the plain search-result row.
  requestsSection: {
    paddingBottom: Spacing.xs,
  },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.xs,
    padding: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.green,
  },
  requestRowMeta: {
    flex: 1,
    marginLeft: Spacing.sm,
    marginRight: Spacing.xs,
  },
  requestActions: {
    flexDirection: "row",
    gap: Spacing.xs,
  },
  requestActionBtn: {
    minWidth: 0,
    paddingHorizontal: 12,
  },

  // Friend row (accepted friends list)
  friendRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
  },
  friendRowMeta: {
    flex: 1,
    marginLeft: Spacing.sm,
    marginRight: Spacing.xs,
  },

  // Calorie pill
  caloriePill: {
    flexDirection: "row",
    alignItems: "baseline",
    marginTop: 4,
  },
  caloriePillText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    fontFamily: Fonts.mono.semibold,
    color: Colors.green,
  },
  caloriePillLabel: {
    fontSize: Typography.xs,
    color: Colors.textMuted,
  },

  // Follow button
  followBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    minWidth: 84,
    alignItems: "center",
  },
  followBtnActive: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  followBtnInactive: {
    backgroundColor: Colors.green,
  },
  followBtnText: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
  },

  // Unfollow (secondary, text-only)
  unfollowBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  unfollowBtnText: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    fontWeight: Typography.medium,
  },

  // Avatar
  avatar: {
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    color: Colors.text,
    fontWeight: Typography.bold,
  },

  // States
  centred: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.xl,
  },
  errorText: {
    color: Colors.danger,
    fontSize: Typography.base,
    textAlign: "center",
  },
  emptySearchText: {
    color: Colors.textMuted,
    fontSize: Typography.base,
    textAlign: "center",
  },

  // Empty following state
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.xl,
    gap: Spacing.sm,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: Typography.md,
    fontWeight: Typography.semibold,
    color: Colors.text,
    textAlign: "center",
  },
  emptyBody: {
    fontSize: Typography.sm,
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  }),
);
