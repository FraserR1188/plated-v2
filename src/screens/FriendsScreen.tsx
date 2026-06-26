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

import { Colors, Spacing, Typography, Radius } from "../theme";
import {
  searchUsers,
  followUser,
  unfollowUser,
  getFollowing,
  getTodayCaloriesForUser,
} from "../lib/social";
import { RootStackParamList, ProfileWithFollowState, Profile } from "../types";

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

// ─── Follow button ───────────────────────────────────────────

function FollowButton({
  isFollowing,
  onPress,
  loading,
}: {
  isFollowing: boolean;
  onPress: () => void;
  loading: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.7}
      style={[
        styles.followBtn,
        isFollowing ? styles.followBtnActive : styles.followBtnInactive,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={isFollowing ? Colors.textSub : Colors.bg}
        />
      ) : (
        <Text
          style={[
            styles.followBtnText,
            { color: isFollowing ? Colors.textSub : Colors.bg },
          ]}
        >
          {isFollowing ? "Following" : "Follow"}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ─── User row (search results) ───────────────────────────────

interface UserRowProps {
  item: ProfileWithFollowState;
  onFollow: (userId: string) => void;
  onUnfollow: (userId: string) => void;
  onPress: (profile: Profile) => void;
  loadingId: string | null;
}

function UserRow({
  item,
  onFollow,
  onUnfollow,
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
        <View style={styles.userRowNameRow}>
          <Text style={styles.userRowDisplayName} numberOfLines={1}>
            {displayName}
          </Text>
          {item.follows_you && (
            <View style={styles.followsYouBadge}>
              <Text style={styles.followsYouText}>follows you</Text>
            </View>
          )}
        </View>
        <Text style={styles.userRowUsername}>@{item.username}</Text>
      </View>
      <FollowButton
        isFollowing={item.is_following}
        onPress={() =>
          item.is_following ? onUnfollow(item.user_id) : onFollow(item.user_id)
        }
        loading={isLoading}
      />
    </Pressable>
  );
}

// ─── Friend row (following list) ─────────────────────────────

interface FriendRowProps {
  item: ProfileWithFollowState & { todayCalories?: number };
  onUnfollow: (userId: string) => void;
  onPress: (profile: Profile) => void;
  loadingId: string | null;
}

function FriendRow({ item, onUnfollow, onPress, loadingId }: FriendRowProps) {
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
        onPress={() => onUnfollow(item.user_id)}
        disabled={isLoading}
        activeOpacity={0.7}
        style={styles.unfollowBtn}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={Colors.textMuted} />
        ) : (
          <Text style={styles.unfollowBtnText}>Unfollow</Text>
        )}
      </TouchableOpacity>
    </Pressable>
  );
}

// ─── Empty state ─────────────────────────────────────────────

function EmptyFollowing() {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>👥</Text>
      <Text style={styles.emptyTitle}>No one here yet</Text>
      <Text style={styles.emptyBody}>
        Search for friends by username and follow them to see their daily log.
      </Text>
    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────

export function FriendsScreen() {
  const navigation = useNavigation<Nav>();

  // Search state
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProfileWithFollowState[]>(
    [],
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Following list state
  const [following, setFollowing] = useState<
    (ProfileWithFollowState & { todayCalories?: number })[]
  >([]);
  const [loadingList, setLoadingList] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Per-row loading state (follow / unfollow in-flight)
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Debounce ref
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load following list ────────────────────────────────────

  const loadFollowing = useCallback(async () => {
    try {
      const list = await getFollowing();
      // Fetch today's calories for each person in parallel
      const enriched = await Promise.all(
        list.map(async (f) => ({
          ...f,
          todayCalories: await getTodayCaloriesForUser(f.user_id),
        })),
      );
      setFollowing(enriched);
    } catch (err) {
      console.error("loadFollowing error:", err);
    } finally {
      setLoadingList(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadFollowing();
  }, [loadFollowing]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFollowing();
  }, [loadFollowing]);

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
      } catch {
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

  // ── Follow / Unfollow ──────────────────────────────────────

  const handleFollow = useCallback(
    async (userId: string) => {
      setLoadingId(userId);
      try {
        await followUser(userId);
        // Update search results optimistically
        setSearchResults((prev) =>
          prev.map((u) =>
            u.user_id === userId ? { ...u, is_following: true } : u,
          ),
        );
        // Refresh following list
        await loadFollowing();
      } catch {
        Alert.alert("Error", "Could not follow user. Please try again.");
      } finally {
        setLoadingId(null);
      }
    },
    [loadFollowing],
  );

  const handleUnfollow = useCallback(async (userId: string) => {
    Alert.alert("Unfollow", "You'll no longer be able to see their log.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unfollow",
        style: "destructive",
        onPress: async () => {
          setLoadingId(userId);
          try {
            await unfollowUser(userId);
            setFollowing((prev) => prev.filter((f) => f.user_id !== userId));
            setSearchResults((prev) =>
              prev.map((u) =>
                u.user_id === userId ? { ...u, is_following: false } : u,
              ),
            );
          } catch {
            Alert.alert("Error", "Could not unfollow. Please try again.");
          } finally {
            setLoadingId(null);
          }
        },
      },
    ]);
  }, []);

  // ── Navigate to connected user's log ──────────────────────

  const handleViewLog = useCallback(
    (profile: Profile) => {
      navigation.navigate("ConnectedUserLog", {
        profile,
        date: todayKey(),
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
                  onFollow={handleFollow}
                  onUnfollow={handleUnfollow}
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
        /* ── Following list ── */
        <View style={styles.flex}>
          {loadingList ? (
            <View style={styles.centred}>
              <ActivityIndicator color={Colors.green} />
            </View>
          ) : (
            <>
              {following.length > 0 && (
                <Text style={styles.sectionLabel}>Following</Text>
              )}
              <FlatList
                data={following}
                keyExtractor={(item) => item.user_id}
                contentContainerStyle={[
                  styles.listContent,
                  following.length === 0 && styles.listContentEmpty,
                ]}
                ListEmptyComponent={<EmptyFollowing />}
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
                    onUnfollow={handleUnfollow}
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

const styles = StyleSheet.create({
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
    borderRadius: Radius.md,
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
  userRowNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
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

  // "follows you" badge
  followsYouBadge: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  followsYouText: {
    fontSize: 10,
    color: Colors.textSub,
    fontWeight: Typography.medium,
  },

  // Friend row (following list)
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
    borderRadius: Radius.full,
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
    color: "#fff",
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
});
