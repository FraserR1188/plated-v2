import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView }                  from 'react-native-safe-area-context';
import { useStore }                      from '../store/useStore';
import { exportCSV, last30Days }         from '../lib/csv';
import { Colors, Spacing, Radius, Typography } from '../theme';

export function SettingsScreen() {
  const { goals, saveGoals, getAllEntries, savedIngredients, deleteIngredient } = useStore();

  const [calories, setCalories] = useState(String(goals.calories));
  const [protein,  setProtein]  = useState(String(goals.protein));
  const [carbs,    setCarbs]    = useState(String(goals.carbs));
  const [fat,      setFat]      = useState(String(goals.fat));
  const [salt,     setSalt]     = useState(String(goals.salt));
  const [fibre,    setFibre]    = useState(String(goals.fibre));
  const [sugar,    setSugar]    = useState(String(goals.sugar));
  const [saving,   setSaving]   = useState(false);
  const [exporting,setExporting]= useState(false);

  const handleSave = async () => {
    setSaving(true);
    await saveGoals({
      calories: parseInt(calories) || 2000,
      protein:  parseInt(protein)  || 150,
      carbs:    parseInt(carbs)    || 200,
      fat:      parseInt(fat)      || 65,
      salt:     parseFloat(salt)   || 6,
      fibre:    parseInt(fibre)    || 30,
      sugar:    parseInt(sugar)    || 30,
    });
    setSaving(false);
    Alert.alert('Saved', 'Daily goals updated.');
  };

  const handleExport = async () => {
    const entries = last30Days(getAllEntries());
    if (entries.length === 0) { Alert.alert('No data', 'No entries in the last 30 days.'); return; }
    setExporting(true);
    try { await exportCSV(entries); }
    catch (e: any) { Alert.alert('Export failed', e.message); }
    finally { setExporting(false); }
  };

  const handleDeleteIngredient = (id: string, name: string) => {
    Alert.alert('Remove from library', `Remove "${name}" from your saved ingredients?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => deleteIngredient(id) },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.heading}>Settings</Text>

        {/* Goals */}
        <Text style={styles.section}>Daily goals</Text>
        <View style={styles.card}>
          {[
            ['Calories', 'kcal', calories, setCalories],
            ['Protein',  'g',    protein,  setProtein],
            ['Carbs',    'g',    carbs,    setCarbs],
            ['Fat',      'g',    fat,      setFat],
            ['Salt',     'g',    salt,     setSalt],
            ['Fibre',    'g',    fibre,    setFibre],
            ['Sugar',    'g',    sugar,    setSugar],
          ].map(([label, unit, value, setter], i, arr) => (
            <View key={label as string} style={[styles.goalRow, i < arr.length-1 && styles.goalBorder]}>
              <Text style={styles.goalLabel}>{label as string}</Text>
              <View style={styles.goalRight}>
                <TextInput style={styles.goalInput} value={value as string} onChangeText={setter as (t:string)=>void} keyboardType="decimal-pad" selectTextOnFocus />
                <Text style={styles.goalUnit}>{unit as string}</Text>
              </View>
            </View>
          ))}
          <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color={Colors.bg} /> : <Text style={styles.saveBtnText}>Save goals</Text>}
          </TouchableOpacity>
        </View>

        {/* CSV Export */}
        <Text style={styles.section}>Export data</Text>
        <View style={styles.card}>
          <Text style={styles.exportInfo}>
            Export the last 30 days as a CSV to cross-reference with your Whoop data in Google Sheets.
          </Text>
          <View style={styles.colsBox}>
            <Text style={styles.colsText}>date · time · meal type · ingredient · brand · serving · calories · protein · carbs · fat · salt · fibre · sugar · source</Text>
          </View>
          {exporting ? (
            <View style={styles.exportLoading}>
              <ActivityIndicator color={Colors.green} />
              <Text style={styles.exportLoadingText}>Preparing file…</Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.exportBtn} onPress={handleExport}>
              <Text style={styles.exportBtnText}>📤  Export last 30 days</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Whoop tip */}
        <Text style={styles.section}>Whoop cross-reference</Text>
        <View style={styles.card}>
          {[
            'Export from plated. using the button above',
            'In Whoop app: Profile → My Data → Export',
            'Open both CSVs in Google Sheets — join on the date column',
            'Use VLOOKUP to match recovery score, HRV, and strain against your daily nutrition',
          ].map((step, i) => (
            <View key={i} style={[styles.step, i < 3 && { marginBottom: Spacing.md }]}>
              <View style={styles.stepNum}><Text style={styles.stepNumText}>{i+1}</Text></View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        {/* Ingredient library */}
        <Text style={styles.section}>Saved ingredients ({savedIngredients.length})</Text>
        {savedIngredients.length > 0 && (
          <View style={styles.card}>
            {savedIngredients.map((item, i) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.libRow, i < savedIngredients.length-1 && styles.goalBorder]}
                onLongPress={() => handleDeleteIngredient(item.id, item.name)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.libName}>{item.name}</Text>
                  <Text style={styles.libSub}>{item.brand ? `${item.brand} · ` : ''}{item.cal_per100} kcal/100g · used {item.use_count}×</Text>
                </View>
              </TouchableOpacity>
            ))}
            <Text style={styles.libHint}>Long-press an ingredient to remove it from your library</Text>
          </View>
        )}

        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Colors.bg },
  content:  { padding: Spacing.md },
  heading:  { fontSize: Typography.xxl, fontWeight: Typography.bold, color: Colors.text, marginBottom: Spacing.lg },
  section:  { fontSize: Typography.xs, fontWeight: Typography.semibold, color: Colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: Spacing.sm, marginTop: Spacing.sm },
  card:     { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.md },
  goalRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.sm },
  goalBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  goalLabel:{ fontSize: Typography.base, color: Colors.text },
  goalRight:{ flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  goalInput:{ backgroundColor: Colors.surface2, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, fontSize: Typography.base, color: Colors.text, fontWeight: Typography.semibold, minWidth: 72, textAlign: 'center' },
  goalUnit: { fontSize: Typography.sm, color: Colors.textMuted, width: 30 },
  saveBtn:  { backgroundColor: Colors.green, borderRadius: Radius.full, paddingVertical: 12, alignItems: 'center', marginTop: Spacing.md },
  saveBtnText: { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.bg },
  exportInfo:  { fontSize: Typography.sm, color: Colors.textMuted, lineHeight: 20, marginBottom: Spacing.sm },
  colsBox:     { backgroundColor: Colors.surface2, borderRadius: Radius.sm, padding: Spacing.sm, marginBottom: Spacing.md },
  colsText:    { fontSize: Typography.xs, color: Colors.textDim, fontStyle: 'italic' },
  exportLoading:     { flexDirection: 'row', gap: Spacing.sm, alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.md },
  exportLoadingText: { fontSize: Typography.base, color: Colors.textMuted },
  exportBtn:    { backgroundColor: Colors.green, borderRadius: Radius.full, paddingVertical: 12, alignItems: 'center' },
  exportBtnText:{ fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.bg },
  step:         { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  stepNum:      { width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.greenDim, borderWidth: 1, borderColor: Colors.green, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  stepNumText:  { fontSize: Typography.xs, fontWeight: Typography.bold, color: Colors.green },
  stepText:     { flex: 1, fontSize: Typography.sm, color: Colors.textMuted, lineHeight: 20 },
  libRow:       { paddingVertical: Spacing.sm },
  libName:      { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text },
  libSub:       { fontSize: Typography.xs, color: Colors.textMuted, marginTop: 2 },
  libHint:      { fontSize: Typography.xs, color: Colors.textDim, marginTop: Spacing.sm, textAlign: 'center' },
});
