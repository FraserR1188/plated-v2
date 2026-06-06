import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStore }     from '../store/useStore';
import { Colors, Spacing, Radius, Typography, MacroColor } from '../theme';

type Range = '7d' | '30d';

export function HistoryScreen() {
  const { entries, goals } = useStore();
  const [range, setRange]  = useState<Range>('7d');
  const days               = range === '7d' ? 7 : 30;

  const dayArray = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  });

  const dayData = dayArray.map((date) => {
    const de = entries.filter((e) => e.date === date);
    return {
      date,
      calories: de.reduce((s,e) => s+e.calories, 0),
      protein:  de.reduce((s,e) => s+e.protein,  0),
      carbs:    de.reduce((s,e) => s+e.carbs,    0),
      fat:      de.reduce((s,e) => s+e.fat,      0),
      salt:     de.reduce((s,e) => s+e.salt,     0),
      fibre:    de.reduce((s,e) => s+e.fibre,    0),
      sugar:    de.reduce((s,e) => s+e.sugar,    0),
      count:    de.length,
    };
  });

  const logged = dayData.filter((d) => d.count > 0);
  const avg = logged.length ? {
    calories: Math.round(logged.reduce((s,d) => s+d.calories,0) / logged.length),
    protein:  +(logged.reduce((s,d) => s+d.protein, 0) / logged.length).toFixed(1),
    carbs:    +(logged.reduce((s,d) => s+d.carbs,   0) / logged.length).toFixed(1),
    fat:      +(logged.reduce((s,d) => s+d.fat,     0) / logged.length).toFixed(1),
    salt:     +(logged.reduce((s,d) => s+d.salt,    0) / logged.length).toFixed(2),
    fibre:    +(logged.reduce((s,d) => s+d.fibre,   0) / logged.length).toFixed(1),
    sugar:    +(logged.reduce((s,d) => s+d.sugar,   0) / logged.length).toFixed(1),
  } : null;

  const fmtDate = (ds: string) => {
    const d   = new Date(ds + 'T12:00:00');
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const yd = new Date(now); yd.setDate(yd.getDate()-1);
    const ydStr = `${yd.getFullYear()}-${String(yd.getMonth()+1).padStart(2,'0')}-${String(yd.getDate()).padStart(2,'0')}`;
    if (ds === todayStr) return 'Today';
    if (ds === ydStr)    return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.heading}>History</Text>

        <View style={styles.rangePicker}>
          {(['7d','30d'] as Range[]).map((r) => (
            <TouchableOpacity key={r} style={[styles.rangeBtn, range===r && styles.rangeBtnOn]} onPress={() => setRange(r)}>
              <Text style={[styles.rangeTxt, range===r && styles.rangeTxtOn]}>{r==='7d'?'Last 7 days':'Last 30 days'}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {avg ? (
          <View style={styles.avgCard}>
            <Text style={styles.avgLabel}>Daily average · {logged.length} days logged</Text>
            <View style={styles.avgRow}>
              {[['Calories',`${avg.calories}kcal`,Colors.green],['Protein',`${avg.protein}g`,MacroColor.protein],['Carbs',`${avg.carbs}g`,MacroColor.carbs],['Fat',`${avg.fat}g`,MacroColor.fat]].map(([l,v,c])=>(
                <View key={l} style={{flex:1,alignItems:'center'}}>
                  <Text style={{fontSize:Typography.md,fontWeight:Typography.bold,color:c}}>{v}</Text>
                  <Text style={{fontSize:Typography.xs,color:Colors.textDim,marginTop:2}}>{l}</Text>
                </View>
              ))}
            </View>
            <View style={[styles.avgRow,{marginTop:Spacing.sm}]}>
              {[['Salt',`${avg.salt}g`,MacroColor.salt],['Fibre',`${avg.fibre}g`,MacroColor.fibre],['Sugar',`${avg.sugar}g`,MacroColor.sugar]].map(([l,v,c])=>(
                <View key={l} style={{flex:1,alignItems:'center'}}>
                  <Text style={{fontSize:Typography.base,fontWeight:Typography.bold,color:c}}>{v}</Text>
                  <Text style={{fontSize:Typography.xs,color:Colors.textDim,marginTop:2}}>{l}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <View style={styles.emptyCard}><Text style={styles.emptyText}>No data logged in this period yet.</Text></View>
        )}

        {dayData.map((day) => {
          const pct  = Math.min(day.calories / goals.calories, 1);
          const over = day.calories > goals.calories;
          return (
            <View key={day.date} style={styles.dayRow}>
              <View style={styles.dayTop}>
                <Text style={styles.dayName}>{fmtDate(day.date)}</Text>
                <Text style={[styles.dayCals, over && {color:Colors.danger}]}>
                  {day.count === 0 ? '—' : `${Math.round(day.calories)} kcal`}
                </Text>
              </View>
              {day.count > 0 && (
                <>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, {width:`${pct*100}%` as any, backgroundColor: over?Colors.danger:Colors.green}]} />
                  </View>
                  <Text style={styles.dayMacros}>
                    P {day.protein.toFixed(1)}g · C {day.carbs.toFixed(1)}g · F {day.fat.toFixed(1)}g · Salt {day.salt.toFixed(2)}g · {day.count} item{day.count!==1?'s':''}
                  </Text>
                </>
              )}
            </View>
          );
        })}
        <View style={{ height: Spacing.xl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Colors.bg },
  content:     { padding: Spacing.md },
  heading:     { fontSize: Typography.xxl, fontWeight: Typography.bold, color: Colors.text, marginBottom: Spacing.md },
  rangePicker: { flexDirection: 'row', backgroundColor: Colors.surface, borderRadius: Radius.full, padding: 4, marginBottom: Spacing.md },
  rangeBtn:    { flex: 1, paddingVertical: 8, borderRadius: Radius.full, alignItems: 'center' },
  rangeBtnOn:  { backgroundColor: Colors.green },
  rangeTxt:    { fontSize: Typography.sm, color: Colors.textMuted, fontWeight: Typography.medium },
  rangeTxtOn:  { color: Colors.bg, fontWeight: Typography.bold },
  avgCard:     { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, marginBottom: Spacing.md },
  avgLabel:    { fontSize: Typography.sm, color: Colors.textMuted, textAlign: 'center', marginBottom: Spacing.md },
  avgRow:      { flexDirection: 'row' },
  emptyCard:   { backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.xl, alignItems: 'center', marginBottom: Spacing.md },
  emptyText:   { fontSize: Typography.base, color: Colors.textMuted },
  dayRow:      { backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm },
  dayTop:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  dayName:     { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.text },
  dayCals:     { fontSize: Typography.base, fontWeight: Typography.bold, color: Colors.text },
  barTrack:    { height: 5, backgroundColor: Colors.surface2, borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  barFill:     { height: 5, borderRadius: 3 },
  dayMacros:   { fontSize: Typography.xs, color: Colors.textMuted },
});
