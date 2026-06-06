import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp }     from '@react-navigation/native-stack';
import { SafeAreaView }                  from 'react-native-safe-area-context';
import { RingChart }                     from '../components/RingChart';
import { MacroBar }                      from '../components/MacroBar';
import { useStore, todayKey }            from '../store/useStore';
import { Colors, Spacing, Radius, Typography } from '../theme';
import { RootStackParamList, MealEntry, MealType, MEAL_TYPES, MEAL_LABELS, MEAL_ICONS } from '../types';

export function TodayScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { goals, getTotalsForDate, getEntriesForMeal, deleteEntry, fetchEntries } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const today  = todayKey();
  const totals = getTotalsForDate(today);

  useFocusEffect(useCallback(() => { fetchEntries(); }, []));

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchEntries();
    setRefreshing(false);
  };

  const handleDelete = (entry: MealEntry) => {
    Alert.alert('Remove ingredient', `Remove "${entry.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => deleteEntry(entry.id) },
    ]);
  };

  const hour     = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.green} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.greeting}>{greeting}</Text>
          <Text style={styles.date}>
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </Text>
        </View>

        {/* Calorie ring */}
        <View style={styles.ringCard}>
          <RingChart value={totals.calories} goal={goals.calories} size={150} />
          <View style={styles.ringStats}>
            <StatRow label="Consumed"  value={`${Math.round(totals.calories)} kcal`} />
            <StatRow label="Goal"      value={`${goals.calories} kcal`} />
            <StatRow label="Remaining" value={`${Math.max(0, goals.calories - Math.round(totals.calories))} kcal`} accent />
          </View>
        </View>

        {/* All macro bars */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Macros</Text>
          <MacroBar label="Protein" value={totals.protein} goal={goals.protein} />
          <MacroBar label="Carbs"   value={totals.carbs}   goal={goals.carbs} />
          <MacroBar label="Fat"     value={totals.fat}      goal={goals.fat} />
          <MacroBar label="Fibre"   value={totals.fibre}   goal={goals.fibre} />
          <MacroBar label="Sugar"   value={totals.sugar}   goal={goals.sugar} />
          <MacroBar label="Salt"    value={totals.salt}    goal={goals.salt}  unit="g" />
        </View>

        {/* Meal sections */}
        {MEAL_TYPES.map((mealType) => (
          <MealSection
            key={mealType}
            mealType={mealType}
            entries={getEntriesForMeal(today, mealType)}
            onAdd={() => navigation.navigate('AddIngredient', { date: today, mealType })}
            onDelete={handleDelete}
          />
        ))}

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Meal section ──────────────────────────────────────────────
function MealSection({ mealType, entries, onAdd, onDelete }: {
  mealType: MealType;
  entries: MealEntry[];
  onAdd: () => void;
  onDelete: (e: MealEntry) => void;
}) {
  const sectionTotals = {
    calories: entries.reduce((s, e) => s + e.calories, 0),
    protein:  entries.reduce((s, e) => s + e.protein,  0),
    carbs:    entries.reduce((s, e) => s + e.carbs,    0),
    fat:      entries.reduce((s, e) => s + e.fat,      0),
  };

  return (
    <View style={mealStyles.section}>
      {/* Section header */}
      <View style={mealStyles.sectionHeader}>
        <View style={mealStyles.sectionLeft}>
          <Text style={mealStyles.sectionIcon}>{MEAL_ICONS[mealType]}</Text>
          <Text style={mealStyles.sectionName}>{MEAL_LABELS[mealType]}</Text>
        </View>
        <Text style={mealStyles.sectionCals}>
          {entries.length > 0 ? `${Math.round(sectionTotals.calories)} kcal` : '—'}
        </Text>
      </View>

      {/* Ingredient rows */}
      {entries.map((entry) => (
        <TouchableOpacity
          key={entry.id}
          style={mealStyles.ingredientRow}
          onLongPress={() => onDelete(entry)}
          activeOpacity={0.7}
        >
          <View style={mealStyles.ingredientBody}>
            <Text style={mealStyles.ingredientName} numberOfLines={1}>
              {entry.name}{entry.brand ? ` · ${entry.brand}` : ''}
            </Text>
            <Text style={mealStyles.ingredientMacros}>
              {Math.round(entry.serving_g)}g · P {entry.protein.toFixed(1)}g · C {entry.carbs.toFixed(1)}g · F {entry.fat.toFixed(1)}g
            </Text>
          </View>
          <Text style={mealStyles.ingredientCals}>{Math.round(entry.calories)}</Text>
        </TouchableOpacity>
      ))}

      {/* Section macro summary (if entries exist) */}
      {entries.length > 0 && (
        <View style={mealStyles.sectionSummary}>
          <Text style={mealStyles.summaryText}>
            P {sectionTotals.protein.toFixed(1)}g · C {sectionTotals.carbs.toFixed(1)}g · F {sectionTotals.fat.toFixed(1)}g
          </Text>
        </View>
      )}

      {/* Add button */}
      <TouchableOpacity style={mealStyles.addBtn} onPress={onAdd} activeOpacity={0.7}>
        <Text style={mealStyles.addBtnText}>＋ Add ingredient</Text>
      </TouchableOpacity>
    </View>
  );
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={{ marginBottom: Spacing.sm }}>
      <Text style={{ fontSize: Typography.xs, color: Colors.textMuted }}>{label}</Text>
      <Text style={{ fontSize: Typography.base, fontWeight: Typography.semibold, color: accent ? Colors.green : Colors.text }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Colors.bg },
  content:  { padding: Spacing.md },
  header:   { marginBottom: Spacing.lg },
  greeting: { fontSize: Typography.xl, fontWeight: Typography.bold, color: Colors.text },
  date:     { fontSize: Typography.sm, color: Colors.textMuted, marginTop: 2 },
  ringCard: { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginBottom: Spacing.md },
  ringStats:{ flex: 1 },
  card:     { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.md },
  cardTitle:{ fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text, marginBottom: Spacing.md },
});

const mealStyles = StyleSheet.create({
  section:       { backgroundColor: Colors.surface, borderRadius: Radius.lg, marginBottom: Spacing.md, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border },
  sectionLeft:   { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  sectionIcon:   { fontSize: 18 },
  sectionName:   { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.text },
  sectionCals:   { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.text },
  ingredientRow: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  ingredientBody:{ flex: 1, marginRight: Spacing.sm },
  ingredientName:{ fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.text },
  ingredientMacros: { fontSize: Typography.xs, color: Colors.textMuted, marginTop: 2 },
  ingredientCals:{ fontSize: Typography.sm, fontWeight: Typography.bold, color: Colors.text },
  sectionSummary:{ padding: Spacing.sm, paddingHorizontal: Spacing.md, borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.surface2 },
  summaryText:   { fontSize: Typography.xs, color: Colors.textMuted },
  addBtn:        { padding: Spacing.md, alignItems: 'center' },
  addBtnText:    { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.green },
});
